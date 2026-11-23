import { useEffect, useRef, useState } from 'react';
import { serverNow } from '../api/client.js';
import { clock } from '../lib/format.js';

/**
 * FR-23: time left on a hold, counted to the server's expiresAt on the server's clock.
 * Calls onExpire once when it reaches 0. Screen readers hear it each minute, not each second.
 */
export default function Countdown({ expiresAt, onExpire }) {
  const end = new Date(expiresAt).getTime();
  const [left, setLeft] = useState(() => end - serverNow());
  const fired = useRef(false);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const ms = end - serverNow();
      setLeft(ms);
      if (ms <= 0 && !fired.current) {
        fired.current = true;
        expireRef.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [end]);

  const urgent = left <= 60_000;
  const minutesLeft = Math.max(0, Math.ceil(left / 60_000));
  return (
    <div className={`countdown${urgent ? ' countdown-urgent' : ''}`}>
      <span className="countdown-label">Seats held for</span>
      <span className="countdown-time" role="timer" aria-live="off" aria-label={`${clock(left)} left`}>
        {clock(left)}
      </span>
      <span className="visually-hidden" aria-live="polite">
        {left > 0 ? `${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} left` : 'Hold expired'}
      </span>
    </div>
  );
}
