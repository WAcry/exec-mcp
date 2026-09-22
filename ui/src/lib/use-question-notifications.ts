import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "../context/LocaleContext";
import type { SessionNotesEvent } from "../../../src/session-notes-types";
import {
  QuestionNotifications,
  type QuestionNotificationState,
} from "./question-notifications";

export function useQuestionNotifications(
  authenticated: boolean,
  openSession: (id: string) => void,
) {
  const { t } = useLocale();
  const translation = useRef(t);
  translation.current = t;
  const notifier = useRef<QuestionNotifications | null>(null);
  const open = useRef(openSession);
  open.current = openSession;
  const [state, setState] = useState<QuestionNotificationState>("default");
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    if (!authenticated) return;
    const current = new QuestionNotifications(
      (id) => open.current(id),
      () => {
        if (notifier.current) setState(notifier.current.state);
      },
      (key, ...values) => translation.current(key, ...values),
    );
    notifier.current = current;
    setState(current.state);
    const refresh = () => current.refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      notifier.current = null;
      current.dispose();
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [authenticated]);

  const receive = useCallback((event: SessionNotesEvent) => {
    void notifier.current?.receive(event);
  }, []);
  const enable = async () => {
    if (requesting) return;
    setRequesting(true);
    try {
      await notifier.current?.enable();
    } finally {
      setRequesting(false);
    }
  };
  return {
    state,
    requesting,
    receive,
    enable,
    pause: () => notifier.current?.pause(),
    test: () => notifier.current?.test(),
  };
}
