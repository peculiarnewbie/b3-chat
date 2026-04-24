import { BUILD_INFO } from "../lib/build-info";

export default function Forbidden() {
  return (
    <main class="auth-shell">
      <section class="auth-card">
        <p class="eyebrow">Unauthorized</p>
        <h1>This deployment is locked to a different Google account.</h1>
        <p>Ask the owner to deploy another Worker for your email.</p>
        <p class="app-version" title={BUILD_INFO.tooltip}>
          {BUILD_INFO.label}
        </p>
      </section>
    </main>
  );
}
