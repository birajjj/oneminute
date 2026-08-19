import { redirect } from "next/navigation";

// Accounts are created by the identity provider, not here — there is nothing to
// sign up for. Kept as a redirect so any existing link still lands somewhere sane.
export default function SignupPage() {
  redirect("/login");
}
