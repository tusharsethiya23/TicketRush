import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** FR-24: the ticket's QR code, drawn in the browser from its ticket code. */
export default function TicketQr({ code, size = 144 }) {
  const [src, setSrc] = useState(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(code, { margin: 1, width: size * 2, errorCorrectionLevel: 'M' })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [code, size]);

  return (
    <figure className="ticket-qr" style={{ width: size }}>
      {src ? (
        <img src={src} width={size} height={size} alt={`QR code for ticket ${code}`} />
      ) : (
        <div className="ticket-qr-placeholder" style={{ width: size, height: size }} aria-hidden="true" />
      )}
      <figcaption className="mono">{code}</figcaption>
    </figure>
  );
}
