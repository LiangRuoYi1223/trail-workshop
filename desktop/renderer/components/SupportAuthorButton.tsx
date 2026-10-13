import { useId, useRef, useState } from 'react';
import paymentCode from '../assets/author-support-wechat.png';

export default function SupportAuthorButton() {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const [imageError, setImageError] = useState(false);

  function showSupport() {
    if (!dialog.current || dialog.current.open) return;
    dialog.current.showModal();
    setOpen(true);
  }

  return <>
    <button id="support-author" type="button" className="support-author-button" ref={trigger}
      aria-haspopup="dialog" aria-controls="author-support-dialog" aria-expanded={open} onClick={showSupport}>
      支持作者
    </button>
    <dialog id="author-support-dialog" className="author-support-dialog" ref={dialog}
      aria-labelledby={titleId} aria-describedby={descriptionId}
      onClose={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }}
      onKeyDown={event => {
        // This dialog has one tabbable control. Keep Tab in the Electron window.
        if (event.key === 'Tab') { event.preventDefault(); closeButton.current?.focus(); }
      }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
      }}>
      <div className="author-support-heading">
        <h2 id={titleId}>支持作者</h2>
        <button type="button" ref={closeButton} autoFocus onClick={() => dialog.current?.close()}>关闭收款码</button>
      </div>
      <p id={descriptionId} className="author-support-description">微信扫码支持作者，感谢你的支持。</p>
      <img className="author-support-image" src={paymentCode} alt="作者微信收款码" draggable={false}
        onError={() => setImageError(true)} />
      {imageError && <p className="author-support-error" role="alert">收款码未能加载，请重新打开软件。</p>}
    </dialog>
  </>;
}
