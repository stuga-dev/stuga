/**
 * Where a sign-in through the identity provider lands for someone this node
 * does not know yet. Two ways on: a new account, which needs an invite exactly
 * as sign-up does, or the account the person already has here, proven by its
 * password. Never matched by username or email: those are claims, not proof.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { USERNAME_RULE, isValidUsername, normalizeUsername } from "@stuga/protocol/domain/username";
import { Brand, nodeName } from "../shell/Brand";
import { AuthErrorBanner } from "../ui/AuthErrorBanner";
import { readStored, removeStored, writeStored } from "../lib/storage";
import { AuthError, describeError } from "../lib/session/errors";
import {
  clearSilentAttempt,
  clearSsoHint,
  fragmentParam,
  setSsoHint,
  startProviderSignIn,
  stripFragment,
} from "../lib/session/provider";
import { inviteTokenIn, peekLoginReturn, pendingInviteToken, safeReturn, takeLoginReturn } from "../lib/session/return-path";
import { usePageRestored } from "../lib/use-page-restored";
import {
  createWithProvider,
  linkWithPassword,
  peekTicket,
  type FirstVisitTicket,
  type ProviderSession,
} from "../lib/session/sign-in";
import { setSession } from "../lib/session/tokens";
import "../styles/auth.css";

/** Kept for the tab, so a reload still finds the ticket after the fragment is stripped. */
const TICKET_KEY = "stuga_first_visit_ticket";

type Mode = "create" | "link";

function backToLogin(nav: NavigateFunction, notice?: string) {
  removeStored("session", TICKET_KEY);
  nav("/login", { replace: true, ...(notice ? { state: { notice } } : {}) });
}

export function FirstVisit() {
  const nav = useNavigate();
  const [ticket] = useState(() => fragmentParam("ticket") ?? readStored("session", TICKET_KEY));
  const [info, setInfo] = useState<FirstVisitTicket | null>(null);

  useEffect(() => {
    if (ticket) writeStored("session", TICKET_KEY, ticket);
    stripFragment();
    clearSilentAttempt();
    // This provider account has none here yet, so a silent attempt from the login page would only come back.
    clearSsoHint();
    if (!ticket) {
      backToLogin(nav, describeError(new AuthError(403, "ticket_invalid")));
      return;
    }
    let alive = true;
    peekTicket(ticket).then(
      (t) => {
        if (alive) setInfo(t);
      },
      (err: unknown) => {
        if (alive) backToLogin(nav, describeError(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [ticket, nav]);

  if (!info || !ticket) {
    return (
      <Center axis="both" className="auth-page">
        <Spinner label="Signing you in…" />
      </Center>
    );
  }
  return <Choices ticket={ticket} info={info} />;
}

/** A new account, or the one this person already has here. */
function Choices({ ticket, info }: { ticket: string; info: FirstVisitTicket }) {
  const nav = useNavigate();
  // The destination the sign-in started from is where an invite shows up: /join/<token>.
  const [invite] = useState(() => inviteTokenIn(info.returnTo) ?? pendingInviteToken());
  const [mode, setMode] = useState<Mode>(invite ? "create" : "link");
  const [username, setUsername] = useState(info.suggestion);
  /**
   * Never the suggestion, which is free and so nobody's account: the name the
   * provider goes by, when it fits here, is a guess the password then proves.
   */
  const [linkUsername, setLinkUsername] = useState(() => {
    const guess = normalizeUsername(info.preferredUsername ?? "");
    return isValidUsername(guess) ? guess : "";
  });
  const [name, setName] = useState(info.name ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** An available username the node offered with a refused one. */
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const who = info.name ?? info.email ?? info.preferredUsername;

  /** Set once "Use a different account" has started: that start replaced the cookie this ticket is bound to. */
  const left = useRef(false);
  // Back from the provider: a spent ticket goes back to sign in, anything else is as it was left.
  usePageRestored(
    useCallback(() => {
      if (left.current) backToLogin(nav);
      else setBusy(false);
    }, [nav]),
  );

  function switchTo(next: Mode) {
    setMode(next);
    setError(null);
    setSuggestion(null);
    setPassword("");
  }

  /** One step: a spent or expired ticket goes back to sign in, anything else is shown here. */
  async function run(step: () => Promise<ProviderSession>, to?: string) {
    setBusy(true);
    setError(null);
    setSuggestion(null);
    try {
      const { session, returnTo } = await step();
      setSession(session);
      removeStored("session", TICKET_KEY);
      setSsoHint();
      const stashed = takeLoginReturn();
      nav(to ?? safeReturn(returnTo ?? stashed), { replace: true });
    } catch (err) {
      if (err instanceof AuthError && err.message === "ticket_invalid") {
        backToLogin(nav, describeError(err));
        return;
      }
      setError(describeError(err));
      if (err instanceof AuthError && err.suggestion) setSuggestion(err.suggestion);
    } finally {
      setBusy(false);
    }
  }

  function create() {
    const handle = normalizeUsername(username);
    if (!isValidUsername(handle)) {
      setError(username.trim() ? USERNAME_RULE : "Choose a username.");
      return;
    }
    // Creation redeemed the invite, so its /join link must not be visited to redeem it again.
    void run(() => createWithProvider(ticket, handle, name, invite ?? undefined), "/");
  }

  /** Back to the provider to choose another account, headed where this sign-in was; the ticket is dead once it starts. */
  function chooseAnotherAccount() {
    setBusy(true);
    setError(null);
    setSuggestion(null);
    startProviderSignIn({ prompt: "select_account", returnTo: safeReturn(info.returnTo ?? peekLoginReturn()) }).then(
      () => {
        left.current = true;
        removeStored("session", TICKET_KEY);
      },
      (err: unknown) => {
        setError(describeError(err));
        setBusy(false);
      },
    );
  }

  function link() {
    if (!linkUsername.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    void run(() => linkWithPassword(ticket, normalizeUsername(linkUsername), password));
  }

  return (
    <Center axis="both" className="auth-page">
      <Card width="100%" maxWidth={480} padding={8} elevation="med">
        <VStack gap={5}>
          <HStack gap={2} vAlign="center">
            <Brand />
            <Text type="body" weight="bold">
              {nodeName()}
            </Text>
          </HStack>

          <VStack gap={1}>
            <Heading level={1} type="display-3">
              {mode === "create" ? "Create your account" : "Link your account"}
            </Heading>
            <Text type="supporting" color="secondary">
              {who ? `Signed in with ${info.label} as ${who}.` : `Signed in with ${info.label}.`}
            </Text>
          </VStack>

          {error && (
            <AuthErrorBanner
              message={error}
              suggestion={suggestion}
              onUseSuggestion={(free) => {
                setUsername(free);
                setError(null);
                setSuggestion(null);
              }}
            />
          )}

          {mode === "create" ? (
            <VStack gap={4}>
              <VStack gap={3}>
                <TextInput label="Full name" size="lg" isOptional value={name} onChange={setName} htmlName="name" />
                <TextInput
                  label="Username"
                  size="lg"
                  isRequired
                  value={username}
                  onChange={setUsername}
                  htmlName="username"
                  autoComplete="username"
                  onEnter={create}
                />
              </VStack>
              <Button label="Create account" variant="primary" size="lg" width="100%" isLoading={busy} onClick={create} />
            </VStack>
          ) : (
            <VStack gap={4}>
              <VStack gap={3}>
                <TextInput
                  label="Username"
                  size="lg"
                  value={linkUsername}
                  onChange={setLinkUsername}
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
                  onEnter={link}
                />
              </VStack>
              <Button label="Link and sign in" variant="primary" size="lg" width="100%" isLoading={busy} onClick={link} />
            </VStack>
          )}

          <VStack gap={2} hAlign="stretch">
            {mode === "create" ? (
              <Button
                label="I already have an account"
                variant="secondary"
                size="lg"
                width="100%"
                isDisabled={busy}
                onClick={() => switchTo("link")}
              />
            ) : invite ? (
              <Button
                label="Create a new account"
                variant="secondary"
                size="lg"
                width="100%"
                isDisabled={busy}
                onClick={() => switchTo("create")}
              />
            ) : (
              <Text type="supporting" color="secondary">
                Creating an account here needs an invite link.
              </Text>
            )}
            <HStack gap={2} justify="center">
              <Button label="Use a different account" variant="ghost" isDisabled={busy} onClick={chooseAnotherAccount} />
              <Button label="Back to sign in" variant="ghost" isDisabled={busy} onClick={() => backToLogin(nav)} />
            </HStack>
          </VStack>
        </VStack>
      </Card>
    </Center>
  );
}
