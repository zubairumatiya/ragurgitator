// UI: the error surface for "you have no key for the provider this needs".
//
// Under strict BYOK this is the first thing a new account sees when it tries to do
// anything, so it gets a LINK rather than a sentence: the whole reason
// MissingProviderKeyError carries its provider is that "add your OpenAI key" should
// be one click, not a search through Settings.
//
// Use <ApiErrorNotice> wherever a component holds the parsed response body and
// renders errors as JSX — it degrades to the plain message for every other kind of
// failure, so it is a drop-in for `<p>{message}</p>`. Surfaces whose error state is a
// bare string (chat bubbles) use errorTextFrom() instead.
"use client";

import Link from "next/link";
import {
  ACCOUNT_PATH,
  errorTextFrom,
  isMissingKeyPayload,
  type MissingKeyFields,
} from "@/lib/http/missingKey";

export function MissingKeyNotice({ provider }: { provider: string }) {
  return (
    <>
      No {provider} API key.{" "}
      <Link href={ACCOUNT_PATH} className="underline underline-offset-2">
        Add your {provider} key
      </Link>{" "}
      to use this.
    </>
  );
}

// What a failed response's parsed JSON — or a stream's error event — looks like
// to a component: a message under either key, plus the missing-key fields when
// that was the cause. They carry the same shape by construction
// (lib/http/missingKey.ts), which is why one renderer serves both.
export type ApiErrorBody = { error?: string; message?: string } & MissingKeyFields;

export function ApiErrorNotice({
  body,
  fallback = "Request failed.",
}: {
  body: ApiErrorBody | null;
  fallback?: string;
}) {
  if (isMissingKeyPayload(body)) return <MissingKeyNotice provider={body.provider} />;
  return <>{errorTextFrom(body, fallback)}</>;
}
