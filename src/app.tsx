import { lazy, Suspense } from "solid-js";
import { MetaProvider, Title } from "@solidjs/meta";
import { Router, Route } from "@solidjs/router";
import "./app.css";
import Forbidden from "./routes/forbidden";

const Home = lazy(() => import("./routes/index"));

function AppShell() {
  return (
    <main class="app-shell">
      <p class="app-shell-spinner" />
    </main>
  );
}

export default function App() {
  return (
    <MetaProvider>
      <Title>b3 chat</Title>
      <Router>
        <Route
          path="/"
          component={() => (
            <Suspense fallback={<AppShell />}>
              <Home />
            </Suspense>
          )}
        />
        <Route path="/forbidden" component={Forbidden} />
      </Router>
    </MetaProvider>
  );
}
