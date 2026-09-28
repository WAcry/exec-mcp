import { useAuth } from "../../context/AuthContext";
import { useLive } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { Loading } from "../ui/Controls";
import { Sigil } from "../ui/Sigil";

/** First run: explain what will appear here and where ChatGPT connects. */
export function HomeView() {
  const { t } = useLocale();
  const { sessions } = useLive();
  const { systemStatus } = useAuth();
  if (!sessions) return <Loading />;
  const endpoint = systemStatus
    ? `http://${systemStatus.mcp.host}:${systemStatus.mcp.port}/mcp`
    : undefined;
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex w-fit items-center gap-3 opacity-80">
          <Sigil id="welcome-a" size={30} live />
          <Sigil id="welcome-b" size={30} />
          <Sigil id="welcome-c" size={30} />
        </div>
        <h1 className="text-xl font-semibold text-ink">{t("home.title")}</h1>
        <p className="mt-2 text-base text-ink-2">{t("home.body")}</p>
        <ol className="mx-auto mt-6 max-w-sm space-y-2.5 text-left text-sm text-ink-2">
          <li className="flex gap-3">
            <span className="tabular text-ink-3">1</span>
            <span>{t("home.step1")}</span>
          </li>
          <li className="flex gap-3">
            <span className="tabular text-ink-3">2</span>
            <span>{t("home.step2")}</span>
          </li>
          <li className="flex gap-3">
            <span className="tabular text-ink-3">3</span>
            <span>{t("home.step3")}</span>
          </li>
        </ol>
        {endpoint && (
          <p className="mt-6 text-xs text-ink-3">
            {t("home.endpoint")}{" "}
            <code className="rounded bg-hover px-1.5 py-0.5 text-ink-2">
              {endpoint}
            </code>
          </p>
        )}
      </div>
    </div>
  );
}
