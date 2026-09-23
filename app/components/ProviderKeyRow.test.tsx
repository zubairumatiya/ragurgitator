import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { KeyFormState } from "@/app/account/actions";
import { ProviderKeyRow } from "@/app/components/ProviderKeyRow";

// The row imports its Server Actions directly (unlike AuthForm, which takes one
// as a prop), so the module is replaced wholesale: the real one pulls in the
// database, Key Vault and the session, none of which exist in jsdom.
const actions = vi.hoisted(() => ({
  saveKey: vi.fn<(prev: KeyFormState, form: FormData) => Promise<KeyFormState>>(async () => ({})),
  deleteKey: vi.fn<(prev: KeyFormState, form: FormData) => Promise<KeyFormState>>(async () => ({})),
}));
vi.mock("@/app/account/actions", () => actions);

const saved = {
  provider: "openai" as const,
  lastFour: "wxyz",
  createdAt: "2026-01-05T00:00:00.000Z",
  updatedAt: "2026-01-05T00:00:00.000Z",
  lastVerifiedAt: null,
};

// A save whose completion the test controls, so the pending label can be read
// while the action is still open.
function deferredSave() {
  let resolve!: (state: KeyFormState) => void;
  actions.saveKey.mockImplementationOnce(() => new Promise<KeyFormState>((r) => (resolve = r)));
  // Read `resolve` at call time: it is only assigned once the action runs.
  return { resolve: (state: KeyFormState) => resolve(state) };
}

describe("ProviderKeyRow", () => {
  it("without a key: Not set, a write-only password field, Save, and no Remove", () => {
    render(<ProviderKeyRow provider="openai" label="OpenAI" role="Answers" />);
    expect(screen.getByText("Not set")).toBeInTheDocument();
    const input = screen.getByLabelText("OpenAI API key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "new-password");
    expect(input).toHaveAttribute("placeholder", "Paste your API key");
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Remove key" })).not.toBeInTheDocument();
  });

  it("with a key: Set, the dates, the last four in the placeholder, Replace and Remove", () => {
    render(
      <ProviderKeyRow
        provider="openai"
        label="OpenAI"
        role="Answers"
        saved={{ ...saved, updatedAt: "2026-02-10T00:00:00.000Z", lastVerifiedAt: "2026-02-10T00:00:00.000Z" }}
      />,
    );
    expect(screen.getByText("Set")).toBeInTheDocument();
    expect(screen.getByText(/^Added .* · replaced .* · verified$/)).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toHaveAttribute(
      "placeholder",
      "••••••••wxyz — enter a new key to replace",
    );
    expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove key" })).toBeEnabled();
  });

  it("a short key with no last four still reads as saved, without inventing a tail", () => {
    render(<ProviderKeyRow provider="openai" label="OpenAI" role="Answers" saved={{ ...saved, lastFour: "" }} />);
    expect(screen.getByLabelText("OpenAI API key")).toHaveAttribute(
      "placeholder",
      "•••••••• saved — enter a new key to replace",
    );
    expect(screen.getByText(/^Added /)).not.toHaveTextContent("replaced");
  });

  it("save: posts provider + key, says Checking… while open, then the verified sentence with the field emptied", async () => {
    const { resolve } = deferredSave();
    const user = userEvent.setup();
    render(<ProviderKeyRow provider="openai" label="OpenAI" role="Answers" />);

    await user.type(screen.getByLabelText("OpenAI API key"), "sk-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(actions.saveKey).toHaveBeenCalledTimes(1);
    const form = actions.saveKey.mock.calls[0][1];
    expect(form.get("provider")).toBe("openai");
    expect(form.get("apiKey")).toBe("sk-secret");

    resolve({ savedProvider: "openai" });
    expect(await screen.findByRole("status")).toHaveTextContent("Verified with OpenAI and saved.");
    expect(screen.getByLabelText("OpenAI API key")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("an error lands under its own provider only", async () => {
    actions.saveKey.mockResolvedValueOnce({ provider: "openai", error: "That key was rejected by OpenAI." });
    const user = userEvent.setup();
    render(<ProviderKeyRow provider="openai" label="OpenAI" role="Answers" />);

    await user.type(screen.getByLabelText("OpenAI API key"), "sk-bad");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That key was rejected by OpenAI.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // The same state, seen by a row for a different provider, shows nothing.
    actions.saveKey.mockResolvedValueOnce({ provider: "voyage", error: "Not yours." });
    await user.type(screen.getByLabelText("OpenAI API key"), "sk-other");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(actions.saveKey).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Not yours.")).not.toBeInTheDocument();
  });

  it("remove: posts the provider, says Removing… while open, and surfaces a refusal", async () => {
    let resolve!: (state: KeyFormState) => void;
    actions.deleteKey.mockImplementationOnce(() => new Promise<KeyFormState>((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<ProviderKeyRow provider="openai" label="OpenAI" role="Answers" saved={saved} />);

    await user.click(screen.getByRole("button", { name: "Remove key" }));
    expect(await screen.findByRole("button", { name: "Removing…" })).toBeDisabled();
    const form = actions.deleteKey.mock.calls[0][1];
    expect(form.get("provider")).toBe("openai");

    resolve({ error: "Could not remove the key." });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not remove the key.");
    expect(screen.getByRole("button", { name: "Remove key" })).toBeEnabled();
  });
});
