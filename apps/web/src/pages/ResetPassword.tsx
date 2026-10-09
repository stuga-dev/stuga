/**
 * Where a password reset link lands, `/reset/<token>`: an administrator mints
 * one under Account recovery, or `reset-password` prints one on the node's
 * machine. A new password signs the person in and ends their other sessions.
 * It is also how an account that has only signed in through the identity
 * provider gets its first password, once the provider is gone.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Brand, nodeName } from "../shell/Brand";
import { AuthError, describeError } from "../lib/session/errors";
import { takeLoginReturn } from "../lib/session/return-path";
import { passwordOk, resetPassword } from "../lib/session/sign-in";
import { setSession } from "../lib/session/tokens";
import { notePasskeyOffer } from "../lib/session/passkey-offer";
import { useRemoteStrength } from "../lib/session/password-strength";
import { PasswordStrengthHint } from "../ui/PasswordStrengthHint";
import { PasswordRules } from "./Login";
import { t } from "../i18n/i18n";
import "../styles/auth.css";

export function ResetPassword() {
  const nav = useNavigate();
  const { token = "" } = useParams();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The link names no account the page can show, so the hint scores without a username; the node checks with it at sign-in.
  const strength = useRemoteStrength(password, { username: "" });

  async function submit() {
    if (!passwordOk(password, strength.strong)) {
      setError(t("auth.choosePassword"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await resetPassword(token, password);
      setSession(session);
      notePasskeyOffer(session);
      nav(takeLoginReturn(), { replace: true });
    } catch (err) {
      // Spent, expired or never minted: nothing here can fix it, and the login page says why.
      if (err instanceof AuthError && err.message === "reset_invalid") {
        nav("/login", { replace: true, state: { notice: describeError(err) } });
        return;
      }
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
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
              {t("auth.reset.title")}
            </Heading>
            <Text type="supporting" color="secondary">
              {t("auth.reset.subtitle")}
            </Text>
          </VStack>

          {error && <Banner status="error" title={error} />}

          <VStack gap={4}>
            <TextInput
              label={t("auth.reset.newPassword")}
              type="password"
              size="lg"
              isRequired
              value={password}
              onChange={setPassword}
              htmlName="new-password"
              autoComplete="new-password"
              onEnter={() => void submit()}
            />
            {password.length > 0 && <PasswordRules password={password} strong={strength.strong} />}
            <PasswordStrengthHint password={password} strength={strength} />
            <Button label={t("auth.reset.setPassword")} variant="primary" size="lg" width="100%" isLoading={busy} onClick={() => void submit()} />
          </VStack>
        </VStack>
      </Card>
    </Center>
  );
}
