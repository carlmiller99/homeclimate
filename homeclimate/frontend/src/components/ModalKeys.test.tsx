import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ModalKeys from "./ModalKeys";

function Dialog({
  onClose,
  closeLabel = "Close",
  children,
}: {
  onClose: () => void;
  closeLabel?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      data-testid="backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" data-testid="box">
        {children}
        {closeLabel && <button onClick={onClose}>{closeLabel}</button>}
      </div>
    </div>
  );
}

function Page({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ModalKeys />
      <button onClick={() => setOpen(true)}>Open</button>
      <input aria-label="behind" />
      {open && children(() => setOpen(false))}
    </>
  );
}

const key = (k: string, shiftKey = false) => fireEvent.keyDown(document, { key: k, shiftKey });
const openIt = async () => {
  const opener = screen.getByRole("button", { name: "Open" });
  opener.focus();
  fireEvent.click(opener);
  await waitFor(() => expect(screen.getByTestId("box")).toHaveFocus());
  return opener;
};

describe("Dialog keyboard behaviour", () => {
  it("moves focus in on open, and back where it was on close", async () => {
    render(<Page>{(close) => <Dialog onClose={close} />}</Page>);
    const opener = await openIt();
    expect(screen.getByTestId("box")).toHaveAttribute("tabindex", "-1");
    key("Escape");
    await waitFor(() => expect(screen.queryByTestId("box")).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("leaves by Close or Cancel, and by the backdrop where there is neither", async () => {
    const closed = vi.fn();
    const { rerender } = render(
      <>
        <ModalKeys />
        <Dialog onClose={() => closed("cancel")} closeLabel="Cancel" />
      </>
    );
    key("Escape");
    expect(closed).toHaveBeenLastCalledWith("cancel");
    rerender(
      <>
        <ModalKeys />
        <Dialog onClose={() => closed("backdrop")} closeLabel={null}>
          <button disabled>Close</button>
        </Dialog>
      </>
    );
    key("Escape");
    expect(closed).toHaveBeenLastCalledWith("backdrop");
    // Other keys, and keys with no dialog open, do nothing.
    key("a");
    rerender(<ModalKeys />);
    key("Escape");
    key("Tab");
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("keeps Tab inside the dialog", async () => {
    render(
      <Page>
        {(close) => (
          <Dialog onClose={close}>
            <input aria-label="first" />
            <input aria-label="second" />
          </Dialog>
        )}
      </Page>
    );
    await openIt();
    const first = screen.getByLabelText("first");
    const last = screen.getByRole("button", { name: "Close" });
    // From the box itself, Tab goes to the first stop and Shift+Tab to the last.
    key("Tab");
    expect(first).toHaveFocus();
    screen.getByTestId("box").focus();
    key("Tab", true);
    expect(last).toHaveFocus();
    // It wraps at both ends, and is left alone in between.
    key("Tab");
    expect(first).toHaveFocus();
    key("Tab", true);
    expect(last).toHaveFocus();
    screen.getByLabelText("second").focus();
    key("Tab");
    expect(screen.getByLabelText("second")).toHaveFocus();
    // Focus that got out is brought back.
    screen.getByLabelText("behind").focus();
    key("Tab");
    expect(first).toHaveFocus();
  });

  it("holds Tab in a dialog with nothing to stop on, and leaves a focused field alone", async () => {
    const { unmount } = render(
      <>
        <ModalKeys />
        <Dialog onClose={() => {}} closeLabel={null} />
      </>
    );
    const held = fireEvent.keyDown(document, { key: "Tab" });
    expect(held).toBe(false);
    unmount();
    // A dialog that focuses its own field on opening keeps that focus.
    function Auto() {
      return (
        <div className="modal-backdrop">
          <div className="modal" tabIndex={-1}>
            <input aria-label="name" autoFocus />
          </div>
        </div>
      );
    }
    render(
      <>
        <ModalKeys />
        <Auto />
      </>
    );
    await act(async () => {});
    expect(screen.getByLabelText("name")).toHaveFocus();
  });

  it("works on the dialog on top when one opens over another", async () => {
    const closed = vi.fn();
    function Two() {
      const [second, setSecond] = useState(false);
      return (
        <>
          <ModalKeys />
          <Dialog onClose={() => closed("first")}>
            <button onClick={() => setSecond(true)}>More</button>
          </Dialog>
          {second && (
            <div className="modal-backdrop" onClick={() => setSecond(false)}>
              <span>bare</span>
            </div>
          )}
        </>
      );
    }
    render(<Two />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(screen.getByText("bare").parentElement).toHaveFocus());
    key("Escape");
    await waitFor(() => expect(screen.queryByText("bare")).not.toBeInTheDocument());
    expect(closed).not.toHaveBeenCalled();
    key("Escape");
    expect(closed).toHaveBeenCalledWith("first");
  });
});
