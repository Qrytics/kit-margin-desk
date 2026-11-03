import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (process.env.DEMO_MODE === "true") throw redirect("/app");
  if (url.searchParams.get("shop")) throw redirect(`/app?${url.searchParams.toString()}`);
  throw redirect("/auth/login");
};
