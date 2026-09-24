import { useCallback, useEffect, useState } from "react";
import { Me, NodeSettings as NodeApi, type NodeAiSettings, type NodeOperationalSettings } from "../../../api";

/**
 * The gate and the settings more than one section reads. `allowed` is null until
 * whoami answers; the server is the real gate, this only hides what it would refuse.
 */
export function useNodeSettings() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [ai, setAi] = useState<NodeAiSettings | null>(null);
  const [ops, setOps] = useState<NodeOperationalSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const fail = () => alive && setFailed(true);
    Me.whoami()
      .then((me) => {
        if (!alive) return;
        setAllowed(me.node_admin);
        if (!me.node_admin) return;
        NodeApi.ai().then((r) => alive && setAi(r), fail);
        NodeApi.settings().then((r) => alive && setOps(r), fail);
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setFailed(false);
    setAllowed(null);
    setAi(null);
    setOps(null);
    setAttempt((n) => n + 1);
  }, []);

  return { allowed, ai, setAi, ops, setOps, failed, retry };
}
