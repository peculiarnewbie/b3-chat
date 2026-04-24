type SettingsPageProps = {
  workspaceName: string | undefined;
  systemPromptDraft: string;
  onSystemPromptInput: (value: string) => void;
  onBack: () => void;
  onCancel: () => void;
  onSave: () => void;
  expandReasoningByDefault: boolean;
  onExpandReasoningChange: (checked: boolean) => void;
  preferFreeSearch: boolean;
  onPreferFreeSearchChange: (checked: boolean) => void;
  onResetAllData: () => void;
};

export default function SettingsPage(props: SettingsPageProps) {
  return (
    <div class="settings-page">
      <header class="settings-header">
        <button class="btn" onClick={props.onBack}>
          ← Back
        </button>
        <h2>Settings</h2>
        <span class="settings-workspace">{props.workspaceName}</span>
      </header>
      <div class="settings-body">
        <div class="settings-section">
          <label class="settings-label">System Prompt</label>
          <p class="settings-hint">
            Instructions prepended to every conversation in this workspace.
          </p>
          <textarea
            class="settings-textarea"
            value={props.systemPromptDraft}
            onInput={(e) => props.onSystemPromptInput(e.currentTarget.value)}
            placeholder="You are a helpful assistant..."
            rows={8}
          />
        </div>
        <div class="settings-actions">
          <button class="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button class="btn btn-primary" onClick={props.onSave}>
            Save
          </button>
        </div>

        <div class="settings-section">
          <label class="settings-toggle">
            <input
              type="checkbox"
              checked={props.expandReasoningByDefault}
              onChange={(e) => props.onExpandReasoningChange(e.currentTarget.checked)}
            />
            <span class="settings-label">Expand reasoning by default</span>
          </label>
          <p class="settings-hint">
            Keep the reasoning chip open after a response finishes, instead of auto-collapsing it.
          </p>
        </div>

        <div class="settings-section">
          <label class="settings-toggle">
            <input
              type="checkbox"
              checked={props.preferFreeSearch}
              onChange={(e) => props.onPreferFreeSearchChange(e.currentTarget.checked)}
            />
            <span class="settings-label">Use free web search</span>
          </label>
          <p class="settings-hint">
            Route web searches through Exa&apos;s public MCP endpoint instead of the paid API.
            Slower and returns raw text instead of ranked results, but avoids usage on your Exa API
            key.
          </p>
        </div>

        <div class="settings-section settings-danger">
          <label class="settings-label">Danger Zone</label>
          <p class="settings-hint">Wipe all data on server and locally. Start completely fresh.</p>
          <button class="btn btn-danger" onClick={props.onResetAllData}>
            Reset All Data
          </button>
        </div>
      </div>
    </div>
  );
}
