import { useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelSection } from './primitives';

afterEach(cleanup);

/*
 * A section keeps its own open state unless its owner states one. The owner's state is for a section that can be absent while its owner
 * stays (the connector editor, for the moment after an apply while the connectors are listed again): it would come back collapsed.
 */
describe('a section with its own open state', () => {
  it('starts as asked and toggles', () => {
    render(
      <PanelSection title="Alpha" defaultOpen={false}>
        <p>body</p>
      </PanelSection>,
    );
    const toggle = screen.getByRole('button', { name: /Alpha/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('a section whose owner holds the open state', () => {
  function Owner({ shown }: { readonly shown: boolean }): ReactNode {
    const [open, setOpen] = useState(false);
    return shown ? (
      <PanelSection title="Beta" open={open} onOpenChange={setOpen}>
        <p>body</p>
      </PanelSection>
    ) : (
      <p>gap</p>
    );
  }
  function Harness(): ReactNode {
    const [shown, setShown] = useState(true);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setShown((current) => !current);
          }}
        >
          flip
        </button>
        <Owner shown={shown} />
      </>
    );
  }

  it('is as the owner says, and the choice survives the section being absent and back', () => {
    render(<Harness />);
    const toggle = (): HTMLElement => screen.getByRole('button', { name: /Beta/ });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(screen.queryByRole('button', { name: /Beta/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  });
});
