import type { RPCSchema } from "electrobun";

export type MarginaliaRPC = {
  bun: RPCSchema<{
    requests: {};
    messages: {
      sendMessage: { text: string };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      onStatus: { status: string };
      onText: { text: string };
      onDone: {};
      onError: { error: string };
    };
  }>;
};
