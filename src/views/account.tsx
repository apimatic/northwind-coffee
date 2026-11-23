import { PASSWORD_MIN_LENGTH } from "../services/identity";
import { Alert, CsrfField, type FieldErrors, PageHeader, TextField } from "./components";
import { Layout, type PageContext } from "./layout";

function withReturnUrl(path: string, returnUrl: string): string {
  return returnUrl === "/" ? path : `${path}?returnUrl=${encodeURIComponent(returnUrl)}`;
}

export function SignInView(props: {
  ctx: PageContext;
  returnUrl: string;
  email?: string;
  errors?: FieldErrors;
  failed?: boolean;
}) {
  const errors = props.errors ?? {};
  return (
    <Layout ctx={props.ctx} title="Sign in">
      <div class="narrow">
        <PageHeader title="Sign in" />
        {props.failed ? <Alert kind="error">The email or password is incorrect.</Alert> : null}
        <form method="post" action={withReturnUrl("/account/login", props.returnUrl)} class="card form-card" novalidate>
          <CsrfField token={props.ctx.csrfToken} />
          <TextField
            label="Email"
            name="email"
            type="email"
            value={props.email}
            error={errors.email}
            autocomplete="email"
          />
          <TextField
            label="Password"
            name="password"
            type="password"
            error={errors.password}
            autocomplete="current-password"
          />
          <button type="submit" class="button button-large">
            Sign in
          </button>
        </form>
        <p class="form-footer">
          New to Northwind Coffee? <a href={withReturnUrl("/account/register", props.returnUrl)}>Create an account</a>
        </p>
      </div>
    </Layout>
  );
}

export function RegisterView(props: { ctx: PageContext; returnUrl: string; email?: string; errors?: FieldErrors }) {
  const errors = props.errors ?? {};
  return (
    <Layout ctx={props.ctx} title="Create an account">
      <div class="narrow">
        <PageHeader title="Create an account" />
        <form
          method="post"
          action={withReturnUrl("/account/register", props.returnUrl)}
          class="card form-card"
          novalidate
        >
          <CsrfField token={props.ctx.csrfToken} />
          <TextField
            label="Email"
            name="email"
            type="email"
            value={props.email}
            error={errors.email}
            autocomplete="email"
          />
          <TextField
            label="Password"
            name="password"
            type="password"
            error={errors.password}
            autocomplete="new-password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          />
          <TextField
            label="Confirm password"
            name="confirmPassword"
            type="password"
            error={errors.confirmPassword}
            autocomplete="new-password"
          />
          <button type="submit" class="button button-large">
            Create account
          </button>
        </form>
        <p class="form-footer">
          Already have an account? <a href={withReturnUrl("/account/login", props.returnUrl)}>Sign in</a>
        </p>
      </div>
    </Layout>
  );
}
