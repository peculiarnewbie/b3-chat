export default function Forbidden() {
  return (
    <main class="auth-shell">
      <section class="auth-card">
        <p class="eyebrow">Unauthorized</p>
        <h1>This deployment is locked to a different Google account.</h1>
        <p>Ask the owner to deploy another Worker for your email.</p>
      </section>
    </main>
  );
}
