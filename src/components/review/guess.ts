/**
 * Best-effort guesses used to prefill the "Create application" form for an email that matched
 * no job. They are only suggestions: the user sees and can edit both fields before anything is
 * created. They live in the email pipeline, which also names the jobs it creates from
 * confirmations with them, so the review form and the server share one implementation.
 */
export { guessCompany, guessTitle } from "@/lib/inbox/pipeline/extract";
