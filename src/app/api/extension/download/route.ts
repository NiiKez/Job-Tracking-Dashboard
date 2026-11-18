// Settings' Download button: the built extension as a zip, to unzip and load unpacked. Cookie
// route; 404 { error } when this server has no build (src/lib/server/extension/build-info.ts),
// 403 { error } in the public demo, which has no extension.
// No Content-Length: Next.js drops it from every Route Handler's response.
import { EXTENSION_OFF_IN_DEMO, refuseInDemo } from "@/lib/server/auth/access";
import { route } from "@/lib/server/auth/guard";
import { openExtensionDownload } from "@/lib/server/services/extension";

export const GET = route(async () => {
  const refused = refuseInDemo(EXTENSION_OFF_IN_DEMO);
  if (refused) return refused;
  const zip = await openExtensionDownload();
  return new Response(zip.bytes, {
    headers: {
      "Content-Type": "application/zip",
      // The version is checked to be digits and dots.
      "Content-Disposition": `attachment; filename="job-tracker-extension-${zip.version}.zip"`,
    },
  });
});
