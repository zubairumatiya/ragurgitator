import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RAG_INGESTED_EVENT } from "@/app/components/DocumentList";
import { FileUpload } from "@/app/components/FileUpload";
import { config } from "@/lib/config";
import type { IngestEvent } from "@/lib/rag/pipeline";

// An NDJSON body the component reads through a ReadableStream, one event per
// line — the same wire shape /api/ingest streams. `gate` holds the stream open
// until the test has looked at the pending UI.
function ndjson(events: IngestEvent[], gate?: Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await gate;
      for (const e of events) controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(...responses: Response[]) {
  const fetch = vi.fn();
  for (const r of responses) fetch.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const walk = (fileName: string, chunksAdded: number): IngestEvent[] => [
  { type: "start", total: 1 },
  { type: "step", index: 0, fileName, step: "load" },
  { type: "step", index: 0, fileName, step: "embed" },
  { type: "file-done", index: 0, result: { fileName, chunksAdded } },
  { type: "done", results: [{ fileName, chunksAdded }] },
];

// jsdom's FormData does not see the files user-event puts on an <input
// type="file"> (it reads the element's internal list, which user-event cannot
// reach), so `new FormData(form)` carries one empty entry where the pick should
// be. A subclass that re-reads the input's `files` closes the gap. A jsdom
// shim, not a component one.
beforeEach(() => {
  const Native = FormData;
  vi.stubGlobal(
    "FormData",
    class extends Native {
      constructor(form?: HTMLFormElement) {
        super(form);
        const input = form?.querySelector<HTMLInputElement>('input[type="file"]');
        if (input?.files?.length) {
          this.delete(input.name);
          for (const f of Array.from(input.files)) this.append(input.name, f);
        }
      }
    },
  );
});

describe("FileUpload", () => {
  it("file mode: refuses an empty submit without a request", async () => {
    const fetch = stubFetch();
    const user = userEvent.setup();
    render(<FileUpload />);
    await user.click(screen.getByRole("button", { name: "Ingest" }));
    expect(await screen.findByText("Pick at least one file first.")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("file mode: posts the file as multipart, paints progress while streaming, then the per-file line", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const fetch = stubFetch(ndjson(walk("notes.txt", 3), gate));
    const ingested = vi.fn();
    window.addEventListener(RAG_INGESTED_EVENT, ingested);
    const user = userEvent.setup();
    render(<FileUpload />);

    await user.upload(screen.getByLabelText(/Click to choose files/), new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ingest" }));

    // Pending, with the stream still closed. This is the assertion that fails
    // under <form action>: React 19 holds an action's state updates until its
    // first await settles, so the pending UI would wait for the server.
    expect(await screen.findByRole("button", { name: "Ingesting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Paste text" })).toBeDisabled();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^\/api\/ingest(\?|$)/);
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect((body.get("file") as File).name).toBe("notes.txt");
    expect(body.has("text")).toBe(false);

    open();
    expect(await screen.findByText(/3 chunks/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ingest" })).toBeEnabled();
    expect(ingested).toHaveBeenCalledTimes(1);
    window.removeEventListener(RAG_INGESTED_EVENT, ingested);
  });

  it("file mode: an oversize pick greys out Ingest with the limit named, before any upload", async () => {
    const fetch = stubFetch();
    const user = userEvent.setup();
    render(<FileUpload />);

    const big = new File([new Uint8Array(config.maxUploadBytes + 1)], "big.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText(/Click to choose files/), big);

    expect(await screen.findByText(/Remove some before ingesting/)).toHaveTextContent("max is 4.0 MB");
    expect(screen.getByRole("button", { name: "Ingest" })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("paste mode: refuses blank text, then posts text without a file and shows a mid-stream error", async () => {
    const fetch = stubFetch(
      ndjson([
        { type: "start", total: 1 },
        { type: "error", message: "Embedding failed: quota exceeded." },
      ]),
    );
    const user = userEvent.setup();
    render(<FileUpload />);

    await user.click(screen.getByRole("button", { name: "Paste text" }));
    await user.click(screen.getByRole("button", { name: "Ingest" }));
    expect(await screen.findByText("Paste some text first.")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    await user.type(screen.getByPlaceholderText("Paste document text here..."), "Some text.");
    await user.click(screen.getByRole("button", { name: "Ingest" }));

    expect(await screen.findByText("Embedding failed: quota exceeded.")).toBeInTheDocument();
    const body = (fetch.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.get("text")).toBe("Some text.");
    expect(body.has("file")).toBe(false);
    expect(screen.getByRole("button", { name: "Ingest" })).toBeEnabled();
  });

  it("a non-stream rejection shows the server's sentence, or the status when there is none", async () => {
    const fetch = stubFetch(json({ error: "Upload too large." }, 413), new Response("", { status: 500 }));
    const user = userEvent.setup();
    render(<FileUpload />);
    await user.click(screen.getByRole("button", { name: "Paste text" }));
    const box = screen.getByPlaceholderText("Paste document text here...");

    await user.type(box, "x");
    await user.click(screen.getByRole("button", { name: "Ingest" }));
    expect(await screen.findByText("Upload too large.")).toBeInTheDocument();

    await user.type(box, "y");
    await user.click(screen.getByRole("button", { name: "Ingest" }));
    expect(await screen.findByText("Request failed (500).")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a thrown fetch becomes its message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")));
    const user = userEvent.setup();
    render(<FileUpload />);
    await user.click(screen.getByRole("button", { name: "Paste text" }));
    await user.type(screen.getByPlaceholderText("Paste document text here..."), "x");
    await user.click(screen.getByRole("button", { name: "Ingest" }));
    expect(await screen.findByText("Failed to fetch")).toBeInTheDocument();
  });

  it("library mode: loads the list, says so when empty, and never enables Ingest with nothing picked", async () => {
    stubFetch(json({ documents: [] }, 200));
    const user = userEvent.setup();
    render(<FileUpload />);
    await user.click(screen.getByRole("button", { name: "User library" }));
    expect(await screen.findByText(/Nothing available/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ingest" })).toBeDisabled();
  });

  it("library mode: toggling rows drives the count, and Ingest posts the picked ids as JSON", async () => {
    const docs = [
      { id: "d1", fileName: "one.md", uploadedAt: "2026-01-01T00:00:00.000Z" },
      { id: "d2", fileName: "two.md", uploadedAt: "2026-01-02T00:00:00.000Z" },
    ];
    // Routed by URL, not by order: the library reloads on every status change
    // (the effect keys on it), so the GETs interleave with the POST.
    let listed = 0;
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url) =>
      Promise.resolve(
        url.startsWith("/api/documents/library")
          ? json({ documents: listed++ === 0 ? docs : [docs[1]] }, 200)
          : ndjson([
              { type: "start", total: 1 },
              { type: "done", results: [{ fileName: "one.md", queued: true }] },
            ]),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<FileUpload />);
    await user.click(screen.getByRole("button", { name: "User library" }));

    const one = await screen.findByRole("button", { name: /one\.md/ });
    const two = screen.getByRole("button", { name: /two\.md/ });
    await user.click(one);
    await user.click(two);
    expect(screen.getByText("2 documents selected")).toBeInTheDocument();
    await user.click(two);
    expect(one).toHaveAttribute("aria-pressed", "true");
    expect(two).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("1 document selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ingest" }));
    expect(await screen.findByText(/queued for the batch API/)).toHaveTextContent("one.md");

    const post = fetch.mock.calls.find(([url]) => url.startsWith("/api/ingest/library"));
    expect(post?.[1]?.method).toBe("POST");
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({ documentIds: ["d1"] });
    // The pick is cleared once the ingest ends, and the reloaded library no
    // longer offers the queued document.
    await waitFor(() => expect(screen.queryByRole("button", { name: /one\.md/ })).not.toBeInTheDocument());
    expect(screen.queryByText("1 document selected")).not.toBeInTheDocument();
  });
});
