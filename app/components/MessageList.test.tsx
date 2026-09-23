import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { MessageList, type DisplayMessage } from "@/app/components/MessageList";
import type { RetrievedChunk } from "@/types/rag";

const source = (documentId: string, position: number, text = "chunk text"): RetrievedChunk => ({
  score: 0.912,
  chunk: { embedding: [], chunk: { id: `${documentId}-${position}`, documentId, text, position } },
});

describe("MessageList", () => {
  it("shows the empty-state prompt when there are no messages", () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByText("Ask a question about the documents you ingested.")).toBeInTheDocument();
  });

  it("renders the pending bubble as a status, not as text someone typed", () => {
    render(<MessageList messages={[{ role: "assistant", content: "", pending: true }]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
  });

  it("renders **bold** as <strong> and leaves an unpaired marker as text", () => {
    const messages: DisplayMessage[] = [
      { role: "assistant", content: "The **key** point" },
      { role: "assistant", content: "A stray ** marker" },
    ];
    render(<MessageList messages={messages} />);
    expect(screen.getByText("key").tagName).toBe("STRONG");
    expect(screen.getByText("A stray ** marker")).toBeInTheDocument();
    expect(screen.queryAllByRole("strong")).toHaveLength(1);
  });

  it("turns '- ' bullets into a bullet glyph but keeps user text verbatim", () => {
    render(
      <MessageList
        messages={[
          { role: "user", content: "- not a bullet" },
          { role: "assistant", content: "- first\n* second" },
        ]}
      />,
    );
    expect(screen.getByText("- not a bullet")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items[1]).toHaveTextContent("• first");
    expect(items[1]).toHaveTextContent("• second");
  });

  it("labels a source by file name, falls back to the document id, and toggles expansion", async () => {
    const user = userEvent.setup();
    render(
      <MessageList
        messages={[
          {
            role: "assistant",
            content: "answer",
            sources: [source("doc-1", 3), source("doc-gone", 0)],
            documents: { "doc-1": "notes.pdf" },
          },
        ]}
      />,
    );
    expect(screen.getByText("2 sources")).toBeInTheDocument();
    expect(screen.getByText("notes.pdf · chunk #3")).toBeInTheDocument();
    expect(screen.getByText("doc-gone · chunk #0")).toBeInTheDocument();
    expect(screen.getAllByText("score 0.912")).toHaveLength(2);

    const [card] = screen.getAllByRole("button", { expanded: false });
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "true");
  });

  it("pluralises the source count", () => {
    render(
      <MessageList messages={[{ role: "assistant", content: "a", sources: [source("d", 1)] }]} />,
    );
    expect(screen.getByText("1 source")).toBeInTheDocument();
  });
});
