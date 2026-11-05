// ChatGPT ads conversion pixel: only on the website (usecloudly.dev), never on a self-hosted instance.
export const PIXEL_ID = process.env.NEXT_PUBLIC_SITE_MODE === "marketing" ? process.env.NEXT_PUBLIC_OAI_PIXEL_ID : undefined;

// OpenAI's base snippet (developers.openai.com/ads/measurement-pixel): queues calls until the SDK loads.
export const pixelScript = `(function(w,d,s,u){if(w.oaiq)return;var q=function(){q.q.push(arguments)};q.q=[];w.oaiq=q;var js=d.createElement(s);js.async=true;js.src=u;var f=d.getElementsByTagName(s)[0];f.parentNode.insertBefore(js,f)})(window,document,"script","https://bzrcdn.openai.com/sdk/oaiq.min.js");oaiq("init",{pixelId:${JSON.stringify(PIXEL_ID)}});`;

export function track(...args: unknown[]) {
  (window as { oaiq?: (...a: unknown[]) => void }).oaiq?.(...args);
}

export const trackCustom = (name: string) => track("measure", "custom", { type: "custom" }, { custom_event_name: name });

/** Copying the install command, from the landing page card, a docs code block, or by selecting it. */
export const trackInstallCopy = (text: string) => {
  if (text.includes("install.sh")) trackCustom("install_command_copied");
};
