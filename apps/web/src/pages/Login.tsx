/**
 * Sign in and sign up, one panel so a switch between them keeps what was typed.
 * The password form is always there (sign-up only for a visitor holding an
 * invite link), with "Continue with <label>" under it when the node has an
 * identity provider. A node with no account yet opens on setup instead: there
 * is nobody to sign in as, and the account made there administers the node.
 */
import { useCallback, useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Center } from "@astryxdesign/core/Center";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Banner } from "@astryxdesign/core/Banner";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Spinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Check, LayoutGrid, LogIn, ShieldCheck, Sparkles, UserPlus, Users, Wand2 } from "lucide-react";
import { Brand, PRODUCT_NAME, nodeName } from "../shell/Brand";
import { authConfigUnavailable, loadAuthConfig, nodeUnclaimed, providerLabel } from "../lib/session/auth-config";
import {
  clearSilentAttempt,
  clearSsoHint,
  peekSilentAttempt,
  pendingLinkReturn,
  selectAccountDue,
  silentSignInDue,
  startProviderSignIn,
} from "../lib/session/provider";
import { setSession, getToken, type Session } from "../lib/session/tokens";
import { takeLoginReturn, peekLoginReturn, pendingInviteToken } from "../lib/session/return-path";
import { signUp, signInWithPassword, passwordOk, PASSWORD_RULES } from "../lib/session/sign-in";
import { AuthError, describeError } from "../lib/session/errors";
import { usePageRestored } from "../lib/use-page-restored";
import { AuthErrorBanner } from "../ui/AuthErrorBanner";
import { USERNAME_RULE, isValidUsername, normalizeUsername } from "@stuga/protocol/domain/username";
import { SEARCH_LANGUAGES, type SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { SearchLanguageList } from "../ui/SearchLanguageList";
import "../styles/auth.css";

type View = "setup" | "signin" | "signup";

const COLUMN_MIN_WIDTH = 260;

/**
 * A function: the node's name is known only once the auth config has loaded.
 * It is often a host (livs-air.local:8787), so it stands alone as the object.
 * Setup greets with the product: nobody has named the node yet.
 */
function headingsFor(view: View): { title: string; subtitle?: string } {
  return {
    setup: { title: `Welcome to ${PRODUCT_NAME}` },
    signin: { title: "Welcome back", subtitle: `Sign in to ${nodeName()}` },
    signup: { title: "Create your account" },
  }[view];
}

const CONFIG_NOTICE = "Server unavailable. Sign-in may fail until it returns.";

/** The lowest-priority seeded notice: a routed failure and an unreachable server outrank it. */
const INVITE_NOTICE = "You’re invited. Create an account or sign in to join.";

const CLAIMED_NOTICE = "This server is already set up. Sign in or request an invite.";

/** This browser's time zone, which setup gives the node for the daily backup's hour. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The search languages this browser's own languages name, by primary subtag: ko-KR asks for Korean. */
function browserSearchLanguages(): SearchLanguage[] {
  const primary = new Set(navigator.languages.map((tag) => tag.split("-")[0]!.toLowerCase()));
  return SEARCH_LANGUAGES.filter((l) => primary.has(l));
}

/** `path` with ?provider=failed, as the node sends a failed link back to the page that started it. */
function withFailedOutcome(path: string): string {
  // Already a same-origin path (safeReturn): the base only lets URL parse it.
  const url = new URL(path, "http://node.invalid");
  url.searchParams.set("provider", "failed");
  return url.pathname + url.search + url.hash;
}

export function Login() {
  const nav = useNavigate();
  const location = useLocation();
  // Seeded, not read in an effect, so the form never paints once looking pristine after a failed attempt.
  const routedNotice = (location.state as { notice?: unknown } | null)?.notice;
  const label = providerLabel();
  /** The node sends a refused sign-in through the provider back here with ?provider=failed. */
  const [failedReturn] = useState(() => new URLSearchParams(location.search).get("provider") === "failed");
  /** The round trip that just ended was a silent attempt, whose failure is nobody's news. */
  const [silentReturn] = useState(peekSilentAttempt);
  /**
   * A link to the provider that failed after the node forgot it (it outlived
   * the flow) comes back here, not to the page that started it; someone still
   * signed in goes back there to hear it failed.
   */
  const [failedLink] = useState(() => (failedReturn ? pendingLinkReturn() : null));
  /** Trying the provider with no prompt first: a spinner until it leaves, so the form never flashes. */
  const [silent, setSilent] = useState(() =>
    silentSignInDue({ signedIn: getToken() !== null, failedReturn, silentReturn }),
  );
  /** Peeked, not consumed: enter() spends the stash, and signing in still returns to /join/:token. */
  const [inviteToken] = useState(pendingInviteToken);
  // Someone holding an invite link most likely has no account yet, so the link opens on sign-up.
  const [view, setView] = useState<View>(() => (nodeUnclaimed() ? "setup" : inviteToken !== null ? "signup" : "signin"));
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  /** Setup only: the one request the node makes on its own account, so whoever sets it up sees it first. */
  const [updateCheck, setUpdateCheck] = useState(true);
  /** Setup only: what search gets a tokenizer for, starting from the languages this browser reads. */
  const [searchLanguages, setSearchLanguages] = useState(browserSearchLanguages);
  /** Setup only: the node's setup code, from the link it printed (?setup=) or typed. */
  const [setupCode, setSetupCode] = useState(() => new URLSearchParams(location.search).get("setup") ?? "");
  /** Asked for unless the link brought it, and again when the node refused the one it brought. */
  const [askSetupCode, setAskSetupCode] = useState(() => !new URLSearchParams(location.search).get("setup"));
  const [busy, setBusy] = useState(false);
  /** A sign-in here has sent the visitor on: the live-token redirect below must not send them again. */
  const [entered, setEntered] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    failedReturn && !silentReturn ? `Couldn’t sign in with ${label ?? "the identity provider"}.` : null,
  );
  /** An available username the node offered with a refused one. */
  const [suggestion, setSuggestion] = useState<string | null>(null);
  /** Stays up across a switch between sign-in and sign-up: it is why the visitor is here. */
  const inviteNotice = inviteToken ? INVITE_NOTICE : null;
  const [notice, setNotice] = useState<string | null>(
    typeof routedNotice === "string" ? routedNotice : authConfigUnavailable() ? CONFIG_NOTICE : inviteNotice,
  );

  // A round trip that failed or never finished: the hint must not send the next visit straight back out.
  useEffect(() => {
    clearSilentAttempt();
    // Signed in already (a stale callback, another tab): the redirect below goes on, and a replace here would undo it.
    if (getToken()) return;
    if (failedReturn || silentReturn) clearSsoHint();
    // Out of the address bar, so a reload is a plain visit to the login page. A ?setup= link stays, to be copied.
    if (failedReturn) nav({ pathname: "/login" }, { replace: true, state: location.state });
    // Once per mount: location changes with the replace above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedReturn, silentReturn, nav]);

  useEffect(() => {
    if (!silent) return;
    startProviderSignIn({ prompt: "none", returnTo: peekLoginReturn() }).catch(() => {
      // Refused or unreachable before leaving: forget the hint and show the page as if nothing was tried.
      clearSsoHint();
      setSilent(false);
    });
  }, [silent]);

  // Back from the provider, the page is as it left it: a silent attempt's spinner, a busy button.
  usePageRestored(
    useCallback(() => {
      clearSilentAttempt();
      setSilent(false);
      setBusy(false);
    }, []),
  );

  // Any visit with a live token goes where the user was headed.
  if (getToken() && !entered) return <Navigate to={failedLink ? withFailedOutcome(failedLink) : takeLoginReturn()} replace />;

  if (silent) {
    return (
      <Center axis="both" className="auth-page">
        <Spinner label="Signing you in…" />
      </Center>
    );
  }

  // After setup, an account is created only with an invite link.
  const canSignUp = inviteToken !== null;

  function go(next: View, message?: string) {
    setView(next);
    setError(null);
    setSuggestion(null);
    setNotice(message ?? inviteNotice);
  }

  /** One auth step: shows its failure, with any username the node offered instead, and rethrows it. */
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setSuggestion(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
      if (err instanceof AuthError && err.suggestion) setSuggestion(err.suggestion);
      throw err;
    } finally {
      setBusy(false);
    }
  }

  /**
   * The start can be refused before it navigates (provider unreachable), so its
   * failure is shown. After a sign-out the provider is asked which account to use.
   */
  function startProvider() {
    const prompt = selectAccountDue() ? { prompt: "select_account" as const } : {};
    void run(() => startProviderSignIn({ returnTo: peekLoginReturn(), ...prompt })).catch(() => {});
  }

  /**
   * The return stash is spent even when `to` overrides it, or a later sign-in would revisit a redeemed invite.
   * The router navigates in a transition, so this page renders once more first, with the stash already spent.
   */
  function enter(session: Session, to?: string) {
    setSession(session);
    setEntered(true);
    const stashed = takeLoginReturn();
    nav(to ?? stashed, { replace: true });
  }

  async function submitSignIn() {
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    try {
      await run(async () => {
        enter(await signInWithPassword(normalizeUsername(username), password));
      });
    } catch {
      /* message already surfaced */
    }
  }

  async function submitSignUp() {
    if (!isValidUsername(normalizeUsername(username))) {
      setError(username.trim() ? USERNAME_RULE : "Choose a username.");
      return;
    }
    if (!passwordOk(password)) {
      setError("Choose a password that meets all the requirements below.");
      return;
    }
    if (view === "setup" && !setupCode.trim()) {
      setAskSetupCode(true);
      setError(describeError(new AuthError(403, "setup_code_required")));
      return;
    }
    try {
      await run(async () => {
        const session = await signUp(normalizeUsername(username), password, {
          name,
          invite: inviteToken ?? undefined,
          ...(view === "setup" ? { updateCheck, setupCode, timeZone: browserTimeZone(), searchLanguages } : {}),
        });
        // The node is claimed now, so a later visit to this page must not offer setup again.
        if (view === "setup") void loadAuthConfig();
        // Registration redeemed the invite, so the stashed /join/:token must not redeem it again.
        enter(session, inviteToken ? "/" : undefined);
      });
    } catch (err) {
      if (view === "setup" && err instanceof AuthError && err.message.startsWith("setup_code")) setAskSetupCode(true);
      // Setup lost a race with another first visitor: this one now needs an invite, so it is sent to sign in.
      if (view === "setup") {
        await loadAuthConfig();
        if (!nodeUnclaimed()) go("signin", CLAIMED_NOTICE);
      }
    }
  }

  const heading = headingsFor(view);
  const creating = view === "setup" || view === "signup";
  const showPasswordRules = creating && password.length > 0;

  return (
    <Center axis="both" className="auth-page">
      <div className="auth-card">
        <Card padding={0} width="100%" elevation="med">
          <Grid
            columns={{ minWidth: COLUMN_MIN_WIDTH, repeat: "fit" }}
            gap={8}
            align="stretch"
            className="auth-grid"
          >
            <VStack gap={5} height="100%">
              <HStack gap={2} vAlign="center">
                <Brand />
                <Text type="body" weight="bold">
                  {nodeName()}
                </Text>
              </HStack>

              <VStack gap={1}>
                <Heading level={1} type="display-3">
                  {heading.title}
                </Heading>
                {heading.subtitle && (
                  <Text type="supporting" color="secondary">
                    {heading.subtitle}
                  </Text>
                )}
              </VStack>

              {error && (
                <AuthErrorBanner
                  message={error}
                  suggestion={creating ? suggestion : null}
                  onUseSuggestion={(free) => {
                    setUsername(free);
                    setError(null);
                    setSuggestion(null);
                  }}
                />
              )}
              {notice && !error && <Banner status="info" title={notice} />}

              {view === "signin" && (
                <VStack gap={4}>
                  <VStack gap={3}>
                    <TextInput
                      label="Username"
                      size="lg"
                      value={username}
                      onChange={setUsername}
                      htmlName="username"
                      autoComplete="username"
                    />
                    <TextInput
                      label="Password"
                      type="password"
                      size="lg"
                      value={password}
                      onChange={setPassword}
                      htmlName="password"
                      onEnter={() => void submitSignIn()}
                    />
                  </VStack>
                  <Button
                    label="Sign in"
                    variant="primary"
                    size="lg"
                    width="100%"
                    isLoading={busy}
                    onClick={() => void submitSignIn()}
                  />
                </VStack>
              )}

              {creating && (
                <VStack gap={4}>
                  <VStack gap={3}>
                    {view === "setup" && askSetupCode && (
                      <TextInput
                        label="Setup code"
                        description="On the Mac running Stuga, choose Set Up Stuga… in the menu bar. With Docker, run ./stuga status."
                        size="lg"
                        isRequired
                        value={setupCode}
                        onChange={setSetupCode}
                        htmlName="setup-code"
                        autoComplete="off"
                      />
                    )}
                    <TextInput
                      label="Full name"
                      size="lg"
                      isOptional
                      value={name}
                      onChange={setName}
                      htmlName="name"
                    />
                    <TextInput
                      label="Username"
                      size="lg"
                      isRequired
                      value={username}
                      onChange={setUsername}
                      htmlName="username"
                      autoComplete="username"
                    />
                    <TextInput
                      label="Password"
                      type="password"
                      size="lg"
                      isRequired
                      value={password}
                      onChange={setPassword}
                      htmlName="new-password"
                      onEnter={() => void submitSignUp()}
                    />
                  </VStack>

                  {showPasswordRules && <PasswordRules password={password} />}

                  {view === "setup" && (
                    <>
                      <CheckboxInput
                        label="Check for new versions"
                        description="Checks GitHub daily. Sends no node data."
                        value={updateCheck}
                        onChange={(checked) => setUpdateCheck(checked)}
                      />
                      <SearchLanguageList choices={SEARCH_LANGUAGES} value={searchLanguages} onChange={setSearchLanguages} />
                    </>
                  )}

                  <Button
                    label={view === "setup" ? "Create administrator account" : "Create account"}
                    variant="primary"
                    size="lg"
                    width="100%"
                    isLoading={busy}
                    onClick={() => void submitSignUp()}
                  />
                </VStack>
              )}

              {/* Not at setup: the node's owner always starts with a password. */}
              {label && view !== "setup" && (
                <VStack gap={4}>
                  <Divider label="Or" />
                  <Button
                    label={`Continue with ${label}`}
                    variant="secondary"
                    size="lg"
                    width="100%"
                    icon={<LogIn size={16} />}
                    isDisabled={busy}
                    onClick={() => startProvider()}
                  />
                </VStack>
              )}

              <VStack gap={3} hAlign="stretch">
                {/* The other way in is a full button, not a footnote: an invited visitor may need either one. */}
                {view === "signin" && canSignUp && (
                  <VStack gap={2} hAlign="stretch">
                    <HStack justify="center">
                      <Text type="supporting" color="secondary">
                        Don&apos;t have an account?
                      </Text>
                    </HStack>
                    <Button label="Create account" variant="secondary" size="lg" width="100%" onClick={() => go("signup")} />
                  </VStack>
                )}
                {view === "signin" && !inviteToken && (
                  <Text type="supporting" color="secondary">
                    Need an account? Ask a member for an invite.
                  </Text>
                )}
                {view === "signup" && (
                  <VStack gap={2} hAlign="stretch">
                    <HStack justify="center">
                      <Text type="supporting" color="secondary">
                        Already have an account?
                      </Text>
                    </HStack>
                    <Button label="Sign in" variant="secondary" size="lg" width="100%" onClick={() => go("signin")} />
                  </VStack>
                )}
              </VStack>
            </VStack>

            {/* A token gradient, not a hosted image: this page renders before any session and follows dark mode. */}
            <div className="auth-aside">
              {view === "setup" ? <SetupAside /> : <IntroAside />}
            </div>
          </Grid>
        </Card>
      </div>
    </Center>
  );
}

/** The password policy as a live checklist, shown once the user starts typing. */
export function PasswordRules({ password }: { password: string }) {
  return (
    <VStack gap={1} className="auth-rules">
      {PASSWORD_RULES.map((rule) => {
        const ok = rule.test(password);
        return (
          <HStack key={rule.label} gap={2} vAlign="center">
            <span className={ok ? "auth-rule__ico auth-rule__ico--ok" : "auth-rule__ico"}>
              {ok ? <Check size={12} /> : <span className="auth-rule__dot" />}
            </span>
            <Text type="supporting" size="xsm" color={ok ? "primary" : "secondary"}>
              {rule.label}
            </Text>
          </HStack>
        );
      })}
    </VStack>
  );
}

/** What claiming the node leads to, in the order the visitor will do it. */
function SetupAside() {
  return (
    <VStack gap={6} height="100%" className="auth-aside__inner">
      <Text type="large" weight="semibold">
        Get started in three steps.
      </Text>
      <VStack gap={4}>
        <Feature
          icon={<ShieldCheck size={16} />}
          title="1. Create the administrator"
          body="Manages settings, AI providers, and backups."
        />
        <Feature
          icon={<LayoutGrid size={16} />}
          title="2. Name your workspace"
          body="Holds your documents, databases, and people."
        />
        <Feature
          icon={<UserPlus size={16} />}
          title="3. Invite your team"
          body="Everyone else joins by invite link."
        />
      </VStack>
    </VStack>
  );
}

function IntroAside() {
  return (
    <VStack gap={6} height="100%" className="auth-aside__inner">
      <Text type="large" weight="semibold">
        Documents that write back.
      </Text>
      <VStack gap={4}>
        <Feature
          icon={<Users size={16} />}
          title="Real-time by default"
          body="Edit together, with no conflicts."
        />
        <Feature
          icon={<Wand2 size={16} />}
          title="An AI co-author"
          body="Draft, rewrite, and ask across your documents."
        />
        <Feature
          icon={<Sparkles size={16} />}
          title="Search that understands"
          body="Search by words and by meaning across your workspace."
        />
      </VStack>
    </VStack>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <HStack gap={3}>
      <span className="auth-feature__ico">{icon}</span>
      <VStack gap={0}>
        <Text type="body" size="sm" weight="semibold">
          {title}
        </Text>
        <Text type="supporting" color="secondary">
          {body}
        </Text>
      </VStack>
    </HStack>
  );
}
