import React, { useCallback, useEffect, useState } from 'react';
import { getAuthHeaders } from '../utils/authRequest';
import './PromptSettingsPage.css';

function PromptSettingsPage() {
  const [generationPrompt, setGenerationPrompt] = useState('');
  const [formatPrompt, setFormatPrompt] = useState('');
  const [defaultGeneration, setDefaultGeneration] = useState('');
  const [defaultFormat, setDefaultFormat] = useState('');
  const [generationIsCustom, setGenerationIsCustom] = useState(false);
  const [formatIsCustom, setFormatIsCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedNote, setSavedNote] = useState('');

  const applyPayload = useCallback((data) => {
    setGenerationPrompt(data.generation_prompt || '');
    setFormatPrompt(data.format_prompt || '');
    setDefaultGeneration(data.default_generation_prompt || '');
    setDefaultFormat(data.default_format_prompt || '');
    setGenerationIsCustom(Boolean(data.generation_is_custom));
    setFormatIsCustom(Boolean(data.format_is_custom));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const headers = getAuthHeaders();
        const response = await fetch('/api/auth/prompt-config', { headers });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.detail || 'Could not load prompt settings.');
        }
        if (!cancelled) applyPayload(data);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load prompt settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyPayload]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSavedNote('');
    try {
      const headers = getAuthHeaders({ 'Content-Type': 'application/json' });
      const response = await fetch('/api/auth/prompt-config', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          generation_prompt: generationPrompt,
          format_prompt: formatPrompt,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = data.detail;
        throw new Error(typeof detail === 'string' ? detail : 'Could not save prompt settings.');
      }
      applyPayload(data);
      setSavedNote('Saved. New and regenerated reading guides use these prompts.');
    } catch (err) {
      setError(err.message || 'Could not save prompt settings.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="prompt-settings-page">
        <p className="prompt-settings-status">Loading prompt settings…</p>
      </div>
    );
  }

  return (
    <div className="prompt-settings-page">
      <header className="prompt-settings-header">
        <h1>Reading guide prompts</h1>
        <p>
          These are the defaults used when a reading guide is created or regenerated.
          Depth, emphasis, and a custom angle from the book toolbar are still added after this text.
          Guides you already generated stay as they are until you regenerate them.
        </p>
      </header>

      <section className="prompt-settings-card">
        <div className="prompt-settings-card-title">
          <h2>Generation prompt</h2>
          <span className={generationIsCustom ? 'prompt-badge custom' : 'prompt-badge'}>
            {generationIsCustom ? 'Custom' : 'Default'}
          </span>
        </div>
        <p className="prompt-settings-hint">
          Tells the model how to split the book into roadmap pillars.
        </p>
        <textarea
          value={generationPrompt}
          onChange={(event) => {
            setGenerationPrompt(event.target.value);
            setSavedNote('');
          }}
          rows={14}
          spellCheck="true"
        />
        <button
          type="button"
          className="prompt-settings-text-button"
          onClick={() => {
            setGenerationPrompt(defaultGeneration);
            setSavedNote('');
          }}
        >
          Restore default generation prompt
        </button>
      </section>

      <section className="prompt-settings-card">
        <div className="prompt-settings-card-title">
          <h2>Format prompt</h2>
          <span className={formatIsCustom ? 'prompt-badge custom' : 'prompt-badge'}>
            {formatIsCustom ? 'Custom' : 'Default'}
          </span>
        </div>
        <p className="prompt-settings-hint">
          Tells the model how to write each card: signpost, read along, and carry forward.
        </p>
        <textarea
          value={formatPrompt}
          onChange={(event) => {
            setFormatPrompt(event.target.value);
            setSavedNote('');
          }}
          rows={16}
          spellCheck="true"
        />
        <button
          type="button"
          className="prompt-settings-text-button"
          onClick={() => {
            setFormatPrompt(defaultFormat);
            setSavedNote('');
          }}
        >
          Restore default format prompt
        </button>
      </section>

      {error && <p className="prompt-settings-error">{error}</p>}
      {savedNote && <p className="prompt-settings-saved">{savedNote}</p>}

      <div className="prompt-settings-actions">
        <button type="button" className="prompt-settings-save" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save prompts'}
        </button>
      </div>
    </div>
  );
}

export default PromptSettingsPage;
