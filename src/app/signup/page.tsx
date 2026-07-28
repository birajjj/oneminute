import { Suspense } from "react";
import AuthForm from "../auth/AuthForm";

export const metadata = { title: "Sign up — OneMinute Cloud" };

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <AuthForm mode="signup" />
    </Suspense>
  );
}
