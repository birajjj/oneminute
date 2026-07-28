import { redirect } from "next/navigation";

// Landing goes straight to the app. /browse handles the auth gate itself.
export default function HomePage() {
  redirect("/browse");
}
