import { Form, useActionData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { login } from "../shopify.server";
import { Button, TextField } from "../components/polaris";

export const loader = async ({ request }: LoaderFunctionArgs) => ({ errors: await login(request) });
export const action = async ({ request }: ActionFunctionArgs) => ({ errors: await login(request) });

export default function Login() {
  const data = useActionData<typeof action>();
  const err = (data?.errors as { shop?: string } | undefined)?.shop;
  return (
    <main className="main" style={{ maxWidth: 480 }}>
      <h1 className="verdict">Open Kit Margin Desk from your Shopify admin.</h1>
      <Form method="post" className="stack stack--tight" style={{ marginTop: 24 }}>
        <TextField label="Shop domain" name="shop" placeholder="your-store.myshopify.com" error={err} hint={err ? undefined : "The app installs from the Shopify App Store."} />
        <Button variant="primary" type="submit">Log in</Button>
      </Form>
    </main>
  );
}
