// What every Sentry init shares: collect nothing about the request.
//
// @sentry/nextjs 11 replaced sendDefaultPii with dataCollection, and its defaults
// collect EVERYTHING — headers, cookies, query params, request and response bodies,
// gen-AI inputs and outputs. Here a request body can be a user's document or a
// provider key being saved, and a model call's input is their corpus. Tags set by
// hand (user id, config id, route) are the whole of what an event may carry.
import type { BrowserOptions } from "@sentry/nextjs";

export const dataCollection: NonNullable<BrowserOptions["dataCollection"]> = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
};
