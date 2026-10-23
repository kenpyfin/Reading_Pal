import React from 'react';
import { Dialog } from '@radix-ui/themes';
import './ReaderDialog.css';

export default function ReaderDialog({
  open,
  onOpenChange,
  title,
  children,
  size = 'content',
  variant = 'center',
  className = '',
  bodyClassName = '',
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        className={`reader-dialog reader-dialog--${size} reader-dialog--${variant} ${className}`.trim()}
      >
        <Dialog.Description className="reader-dialog-sr">{title}</Dialog.Description>
        <div className="reader-dialog-header modal-header">
          <Dialog.Title className="reader-dialog-title" mb="0">{title}</Dialog.Title>
          <Dialog.Close>
            <button type="button" className="reader-dialog-close close-button" aria-label="Close">
              ✕
            </button>
          </Dialog.Close>
        </div>
        <div className={`reader-dialog-body modal-body ${bodyClassName}`.trim()}>
          {children}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
