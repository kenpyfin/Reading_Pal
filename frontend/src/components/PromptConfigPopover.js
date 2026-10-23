import React, { useEffect, useState } from 'react';
import {
  Button,
  Flex,
  Popover,
  SegmentedControl,
  Text,
  TextArea,
  TextField,
} from '@radix-ui/themes';
import ReaderDialog from './ReaderDialog';

export const ANGLE_PRESETS = [
  {
    id: 'executive',
    label: 'Executive',
    text: 'Read as an executive looking for actionable frameworks, decisions, and what to do differently.',
  },
  {
    id: 'systems',
    label: 'Systems',
    text: 'Read for systems, mechanisms, and causal logic. Name the moving parts and how they interact.',
  },
  {
    id: 'first_principles',
    label: 'First principles',
    text: 'Read from first principles. Surface assumptions, definitions, and the argument stripped of examples.',
  },
  {
    id: 'quick',
    label: 'Quick',
    text: 'Read for a fast pass: the few claims that change what the reader should believe or do.',
  },
];

const DEPTH_OPTIONS = [
  { value: 'compact', label: 'Compact' },
  { value: 'standard', label: 'Standard' },
  { value: 'high_fidelity', label: 'Detailed' },
];

const EMPHASIS_OPTIONS = [
  { value: 'balanced', label: 'Balance' },
  { value: 'author_craft', label: 'Craft' },
  { value: 'takeaways', label: 'Takeaways' },
];

const DEPTH_HINT = {
  compact: '4\u20136 pillars',
  standard: 'current granularity',
  high_fidelity: 'detailed pillars, no small cap',
};

export function angleCapsuleLabel(guide) {
  const req = (guide?.custom_requirements || '').trim();
  if (!req) return 'Angle';
  return req.length > 28 ? `${req.slice(0, 28)}\u2026` : req;
}

function depthLabel(guide) {
  return DEPTH_OPTIONS.find((opt) => opt.value === (guide?.prompt_depth || 'standard'))?.label || 'Standard';
}

function emphasisLabel(guide) {
  return EMPHASIS_OPTIONS.find((opt) => opt.value === (guide?.prompt_emphasis || 'balanced'))?.label || 'Balance';
}

export function AngleLensPopover({ activeGuide }) {
  const requirements = (activeGuide?.custom_requirements || '').trim();
  return (
    <Popover.Root>
      <Popover.Trigger>
        <button
          type="button"
          className={`reading-guide-angle-capsule${requirements ? ' has-angle' : ''}`}
          title={requirements || 'Reading angle for this guide'}
          aria-label="Reading angle for this guide"
        >
          {angleCapsuleLabel(activeGuide)}
        </button>
      </Popover.Trigger>
      <Popover.Content
        className="prompt-config-popover"
        side="bottom"
        align="start"
        sideOffset={6}
        size="1"
      >
        <Flex direction="column" gap="2">
          <Text size="2" weight="medium">
            Reading angle
          </Text>
          <Text size="2">
            {requirements || 'No custom angle on this guide.'}
          </Text>
          <Text size="1" color="gray">
            Depth · {depthLabel(activeGuide)}
          </Text>
          <Text size="1" color="gray">
            Emphasis · {emphasisLabel(activeGuide)}
          </Text>
          <Text size="1" color="gray">
            This is the lens for the guide you are reading. New guide… creates another one.
          </Text>
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}

export default function PromptConfigPopover({
  open,
  onOpenChange,
  activeGuide,
  canCreate,
  disabled,
  onCreate,
  embedded = false,
}) {
  const [name, setName] = useState('');
  const [requirements, setRequirements] = useState('');
  const [depth, setDepth] = useState('standard');
  const [emphasis, setEmphasis] = useState('balanced');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setRequirements((activeGuide?.custom_requirements || '').trim());
    setDepth(activeGuide?.prompt_depth || 'standard');
    setEmphasis(activeGuide?.prompt_emphasis || 'balanced');
    setAdvancedOpen(Boolean(activeGuide?.prompt_depth && activeGuide.prompt_depth !== 'standard'));
  }, [open, activeGuide]);

  const previewBits = [
    DEPTH_OPTIONS.find((opt) => opt.value === depth)?.label || 'Standard',
    EMPHASIS_OPTIONS.find((opt) => opt.value === emphasis)?.label || 'Balance',
  ];
  const trimmed = requirements.trim();
  const preview = trimmed
    ? `${previewBits.join(' \u00b7 ')} \u00b7 ${trimmed.slice(0, 90)}${trimmed.length > 90 ? '\u2026' : ''}`
    : `${previewBits.join(' \u00b7 ')} \u00b7 no custom angle`;

  const handleCreate = () => {
    if (!onCreate || !canCreate || disabled) return;
    onCreate({
      name: name.trim() || undefined,
      custom_requirements: trimmed || undefined,
      prompt_depth: depth,
      prompt_emphasis: emphasis,
    });
  };

  const form = (
    <Flex direction="column" gap="2">
      {!embedded && (
        <Flex justify="between" align="center">
          <Text size="2" weight="medium">
            Reading angle
          </Text>
          <Popover.Close>
            <button type="button" className="prompt-config-close" aria-label="Close">
              ×
            </button>
          </Popover.Close>
        </Flex>
      )}
      <Text size="1" color="gray">
        Quick presets
      </Text>
      <div className="prompt-config-presets">
        {ANGLE_PRESETS.map((preset) => {
          const selected = trimmed === preset.text;
          return (
            <button
              key={preset.id}
              type="button"
              className={`prompt-config-preset${selected ? ' is-selected' : ''}`}
              onClick={() => setRequirements(preset.text)}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <label className="prompt-config-field">
        <Text size="1" color="gray">
          Custom angle
        </Text>
        <TextArea
          size="1"
          rows={3}
          maxLength={2000}
          value={requirements}
          placeholder="e.g. Read as a product manager looking for actionable frameworks"
          onChange={(event) => setRequirements(event.target.value)}
        />
      </label>
      <label className="prompt-config-field">
        <Text size="1" color="gray">
          Name (optional)
        </Text>
        <TextField.Root
          size="1"
          maxLength={120}
          value={name}
          placeholder="Guide name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="prompt-config-advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((value) => !value)}
      >
        {advancedOpen ? 'Hide advanced directives' : 'Advanced directives'}
      </button>
      {advancedOpen && (
        <Flex direction="column" gap="2">
          <div>
            <Text size="1" color="gray">
              Depth · {DEPTH_HINT[depth]}
            </Text>
            <SegmentedControl.Root size="1" value={depth} onValueChange={setDepth}>
              {DEPTH_OPTIONS.map((opt) => (
                <SegmentedControl.Item key={opt.value} value={opt.value}>
                  {opt.label}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
          </div>
          <div>
            <Text size="1" color="gray">
              Emphasis
            </Text>
            <SegmentedControl.Root size="1" value={emphasis} onValueChange={setEmphasis}>
              {EMPHASIS_OPTIONS.map((opt) => (
                <SegmentedControl.Item key={opt.value} value={opt.value}>
                  {opt.label}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
          </div>
        </Flex>
      )}
      <Text size="1" color="gray" className="prompt-config-preview">
        {preview}
      </Text>
      {!canCreate && (
        <Text size="1" color="gray">
          Maximum of 5 guides. Delete one before creating another.
        </Text>
      )}
      <Flex justify="end" gap="2">
        {embedded ? (
          <Button type="button" size="1" variant="soft" color="gray" onClick={() => onOpenChange && onOpenChange(false)}>
            Cancel
          </Button>
        ) : (
          <Popover.Close>
            <Button type="button" size="1" variant="soft" color="gray">
              Cancel
            </Button>
          </Popover.Close>
        )}
        <Button type="button" size="1" disabled={!canCreate || disabled} onClick={handleCreate}>
          Create &amp; generate
        </Button>
      </Flex>
    </Flex>
  );

  if (embedded) return form;

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger>
        <button
          type="button"
          className={`reading-guide-angle-capsule${(activeGuide?.custom_requirements || '').trim() ? ' has-angle' : ''}`}
          title={activeGuide?.custom_requirements || 'Reading angle and prompt directives'}
          aria-label="Reading angle and prompt directives"
        >
          {angleCapsuleLabel(activeGuide)}
        </button>
      </Popover.Trigger>
      <Popover.Content className="prompt-config-popover" side="bottom" align="start" sideOffset={6} size="1">
        {form}
      </Popover.Content>
    </Popover.Root>
  );
}

export function NewGuideDialog({
  open,
  onOpenChange,
  activeGuide,
  canCreate,
  disabled,
  onCreate,
}) {
  return (
    <ReaderDialog open={open} onOpenChange={onOpenChange} title="New guide" size="content">
      <PromptConfigPopover
        embedded
        open={open}
        onOpenChange={onOpenChange}
        activeGuide={activeGuide}
        canCreate={canCreate}
        disabled={disabled}
        onCreate={onCreate}
      />
    </ReaderDialog>
  );
}
