// The two class strings every form control in the app already uses.
//
// They were duplicated verbatim in AuthForm and ProviderKeyRow; the password
// forms would have made five copies of a string nobody would think to update in
// five places. Not a design system — just the one place these two live.
export const FIELD =
  "w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:focus:border-zinc-500";

export const BUTTON =
  "cursor-pointer rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:cursor-default disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
