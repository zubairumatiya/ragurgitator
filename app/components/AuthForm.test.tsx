import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AuthState } from "@/app/auth/actions";
import { AuthForm } from "@/app/components/AuthForm";
import { PASSWORD_HINT } from "@/lib/auth/passwordPolicy";

const never = vi.fn(async (): Promise<AuthState> => ({}));

describe("AuthForm", () => {
  it("sign-in: heading, no password rules, a recovery link, and the sign-up cross-link", () => {
    render(<AuthForm mode="signin" action={never} />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(screen.queryByText(PASSWORD_HINT)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute(
      "href",
      "/auth/forgot-password",
    );
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.queryByRole("link", { name: "Try the demo" })).not.toBeInTheDocument();
  });

  it("sign-up: the rules are advertised, the password field carries them, and there is no recovery link", () => {
    render(<AuthForm mode="signup" action={never} />);
    expect(screen.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();
    expect(screen.getByText(PASSWORD_HINT)).toBeInTheDocument();
    const password = screen.getByLabelText(/^Password/);
    expect(password).toHaveAttribute("minlength", "8");
    expect(password).toHaveAttribute("maxlength", "72");
    expect(password).toHaveAttribute("aria-describedby", "password-hint");
    expect(screen.queryByRole("link", { name: "Forgot your password?" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("offers the demo only when the deployment has one", () => {
    render(<AuthForm mode="signin" action={never} demoAvailable />);
    expect(screen.getByRole("link", { name: "Try the demo" })).toHaveAttribute("href", "/demo");
  });

  it("carries `next` as a hidden field and shows the initial error and notice", () => {
    const { container } = render(
      <AuthForm
        mode="signin"
        action={never}
        next="/c/abc/eval?tab=1"
        initialError="Session expired."
        initialNotice="Your account and all of its keys have been deleted."
      />,
    );
    expect(container.querySelector('input[name="next"]')).toHaveValue("/c/abc/eval?tab=1");
    expect(screen.getByRole("alert")).toHaveTextContent("Session expired.");
    expect(screen.getByRole("status")).toHaveTextContent("keys have been deleted");
  });

  it("surfaces the action's error and keeps the email after React resets the form", async () => {
    const action = vi.fn(async (_prev: AuthState, form: FormData): Promise<AuthState> => ({
      error: "Incorrect email or password.",
      email: String(form.get("email")),
    }));
    const user = userEvent.setup();
    render(<AuthForm mode="signin" action={action} next="/c/abc" />);

    await user.type(screen.getByLabelText("Email"), "me@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
    expect(action).toHaveBeenCalledTimes(1);
    const form = action.mock.calls[0][1];
    expect(form.get("email")).toBe("me@example.test");
    expect(form.get("password")).toBe("wrong-password");
    expect(form.get("next")).toBe("/c/abc");
    // The reset restores defaultValue, which the echoed email now supplies.
    expect(screen.getByLabelText("Email")).toHaveValue("me@example.test");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});
