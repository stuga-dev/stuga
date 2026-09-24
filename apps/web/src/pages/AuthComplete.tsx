/**
 * Where a sign-in through the identity provider lands for an account this node
 * knows. The node put a one-time code in the fragment, which never reaches a
 * server log; this page trades it for a session and goes where the sign-in was
 * headed. A session that could not be stored is shown in place: /login would
 * only run into the same blocked storage.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Button } from "@astryxdesign/core/Button";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Brand, nodeName } from "../shell/Brand";
import { describeError } from "../lib/session/errors";
import {
  clearSilentAttempt,
  clearSsoHint,
  fragmentParam,
  peekSilentAttempt,
  setSsoHint,
  stripFragment,
} from "../lib/session/provider";
import { safeReturn, takeLoginReturn } from "../lib/session/return-path";
import { redeemHandoff, type ProviderSession } from "../lib/session/sign-in";
import { setSession } from "../lib/session/tokens";

export const HANDOFF_FAILED_NOTICE = "That sign-in didn’t complete. Try again.";

/** Keyed by code: StrictMode runs the effect twice, and a code works once. */
const handoffs = new Map<string, Promise<ProviderSession>>();

export function AuthComplete() {
  const nav = useNavigate();
  const [code] = useState(() => fragmentParam("code"));
  /** A silent attempt that fails here says nothing on the login page, like one the provider refused. */
  const [silent] = useState(peekSilentAttempt);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    stripFragment();
    clearSilentAttempt();
    const failed = () => {
      clearSsoHint();
      nav("/login", { replace: true, state: silent ? undefined : { notice: HANDOFF_FAILED_NOTICE } });
    };
    if (!code) {
      failed();
      return;
    }
    let alive = true;
    let handoff = handoffs.get(code);
    if (!handoff) {
      handoff = redeemHandoff(code);
      handoffs.set(code, handoff);
      // Both runs have subscribed by the time it settles; the session need not outlive them in memory.
      void handoff.catch(() => {}).finally(() => handoffs.delete(code));
    }
    handoff.then(
      ({ session, returnTo }) => {
        if (!alive) return;
        try {
          setSession(session);
        } catch (err) {
          setError(describeError(err));
          return;
        }
        setSsoHint();
        // The node's answer is the same destination; the stash is spent so a later sign-in cannot revisit it.
        takeLoginReturn();
        nav(safeReturn(returnTo), { replace: true });
      },
      () => {
        if (alive) failed();
      },
    );
    return () => {
      alive = false;
    };
  }, [code, silent, nav]);

  return (
    <AppShell>
      <Section padding={6} variant="transparent">
        <VStack gap={3} hAlign="center" style={{ paddingTop: "22vh" }}>
          <HStack gap={2} vAlign="center">
            <Brand />
            <Heading level={1}>{nodeName()}</Heading>
          </HStack>
          {error ? (
            <>
              <Heading level={2}>Couldn’t sign you in</Heading>
              <Text color="secondary">{error}</Text>
              <Button label="Back to sign in" variant="primary" onClick={() => nav("/login", { replace: true })} />
            </>
          ) : (
            <Spinner label="Signing you in…" />
          )}
        </VStack>
      </Section>
    </AppShell>
  );
}
