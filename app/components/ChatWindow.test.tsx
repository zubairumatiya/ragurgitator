import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChatWindow } from "@/app/components/ChatWindow";
import { MISSING_PROVIDER_KEY } from "@/lib/http/missingKey";

// A fetch whose resolution the test controls, so the pending UI can be asserted
// while the request is still in flight — the property handleSubmit exists for.
function deferredFetch() {
  let resolve!: (res: Response) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const fetch = vi.fn(() => promise);
  vi.stubGlobal("fetch", fetch);
  return { fetch, resolve, reject };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const answer = {
  answer: "Forty-two.",
  sources: [
    {
      score: 0.8,
      chunk: { embedding: [], chunk: { id: "c1", documentId: "d1", text: "…", position: 0 } },
    },
  ],
  documents: { d1: "guide.pdf" },
};

describe("ChatWindow", () => {
  it("without a key: disables the input, names the provider, links to Account, and sends nothing", async () => {
    const { fetch } = deferredFetch();
    const user = userEvent.setup();
    render(<ChatWindow hasLlmKey={false} provider="openai" suggestions={["Banked?"]} />);

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByPlaceholderText("Add a openai key to ask questions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Add your openai key" })).toHaveAttribute("href", "/account");

    await user.click(screen.getByRole("button", { name: "Banked?" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("paints the user bubble and the Thinking status before the request resolves, then the answer", async () => {
    const { fetch, resolve } = deferredFetch();
    const user = userEvent.setup();
    render(<ChatWindow />);

    await user.type(screen.getByRole("textbox"), "  What is it?  ");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    // Pending state, with the request still open.
    expect(screen.getByText("What is it?")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(screen.getByRole("button", { name: "Asking…" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveValue("");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/chat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ question: "What is it?" });

    resolve(json(answer));
    expect(await screen.findByText("Forty-two.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("1 source")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled(); // input is empty again
  });

  it("turns a missing-key body into the Account-page sentence", async () => {
    const { resolve } = deferredFetch();
    const user = userEvent.setup();
    render(<ChatWindow />);
    await user.type(screen.getByRole("textbox"), "q");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    resolve(json({ error: "raw", code: MISSING_PROVIDER_KEY, provider: "anthropic" }, 400));

    expect(
      await screen.findByText(
        "Error: No anthropic API key — add one on the Account page (/account) to use this.",
      ),
    ).toBeInTheDocument();
  });

  it("shows a plain error body's message, and a network failure's message", async () => {
    const first = deferredFetch();
    const user = userEvent.setup();
    render(<ChatWindow />);
    await user.type(screen.getByRole("textbox"), "q");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    first.resolve(json({ error: "The demo has no answer-model key." }, 400));
    expect(await screen.findByText("Error: The demo has no answer-model key.")).toBeInTheDocument();

    const second = deferredFetch();
    await user.type(screen.getByRole("textbox"), "again");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    second.reject(new Error("Failed to fetch"));
    expect(await screen.findByText("Error: Failed to fetch")).toBeInTheDocument();
  });

  it("a suggestion chip sends its exact text, and the chips hide only while a question is in flight", async () => {
    const { fetch, resolve } = deferredFetch();
    const user = userEvent.setup();
    render(<ChatWindow suggestions={["Why is the sky blue?", "How big is it?"]} />);

    const prompt = "Try one of these — each has a banked answer:";
    expect(screen.getByText(prompt)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Why is the sky blue?" }));

    expect(screen.queryByText(prompt)).not.toBeInTheDocument();
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ question: "Why is the sky blue?" });

    resolve(json({ ...answer, sources: [] }));
    await waitFor(() => expect(screen.getByText(prompt)).toBeInTheDocument());
    expect(screen.getByText("Forty-two.")).toBeInTheDocument();
  });
});
