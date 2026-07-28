import { Suspense } from "react";
import AuthForm from "../auth/AuthForm";

export const metadata = { title: "Sign in — OneMinute Cloud" };

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
