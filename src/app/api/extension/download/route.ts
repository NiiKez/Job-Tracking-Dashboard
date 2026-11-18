// Settings' Download button: the built extension as a zip, to unzip and load unpacked. Cookie
// route; 404 { error } when this server has no build (src/lib/server/extension/build-info.ts).
// No Content-Length: Next.js drops it from every Route Handler's response.
import { route } from "@/lib/server/auth/guard";
import { openExtensionDownload } from "@/lib/server/services/extension";

export const GET = route(async () => {
  const zip = await openExtensionDownload();
  return new Response(zip.bytes, {
    headers: {
      "Content-Type": "application/zip",
      // The version is checked to be digits and dots.
      "Content-Disposition": `attachment; filename="job-tracker-extension-${zip.version}.zip"`,
    },
  });
});
