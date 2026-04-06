import { MetaProvider, Title } from "@solidjs/meta";
import { Router, Route } from "@solidjs/router";
import "./app.css";
import Home from "./routes/index";
import Forbidden from "./routes/forbidden";

export default function App() {
  return (
    <MetaProvider>
      <Title>b3 chat</Title>
      <Router>
        <Route path="/" component={Home} />
        <Route path="/forbidden" component={Forbidden} />
      </Router>
    </MetaProvider>
  );
}
