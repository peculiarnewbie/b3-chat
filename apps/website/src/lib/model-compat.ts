export function isKimi25ModelId(modelId: string | null | undefined) {
  return /(?:^|\/)kimi-k2(?:[._-])5(?:$|[-/])/i.test(String(modelId ?? "").trim());
}
