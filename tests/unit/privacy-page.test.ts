import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "@/app/privacy/page";

// src/app/privacy/page.tsx: the public privacy policy says what connecting reads, what stays
// after Disconnect, that Disconnect only asks Google to revoke, and what the Chrome extension
// reads, sends and keeps. Text, not layout.

const text = renderToStaticMarkup(createElement(PrivacyPage))
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;|&apos;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, " ");

describe("the privacy page", () => {
  it("says connecting scans the past 180 days, not only new mail", () => {
    expect(text).toContain("scans your mail from the past 180 days");
    expect(text).toContain("reads new mail as it arrives");
  });

  it("lists the connection record that stays after Disconnect", () => {
    expect(text).toMatch(/Gmail connection itself: the Gmail address, Google's id for your account, the permissions/);
    expect(text).toContain("sync bookkeeping");
    expect(text).toContain("This record stays after you disconnect");
  });

  it("says Disconnect asks Google to revoke, and where to remove the access by hand", () => {
    expect(text).toContain("asks Google to revoke the app's access");
    expect(text).not.toMatch(/revokes the app's access/);
    expect(text).toContain("myaccount.google.com/permissions");
  });

  it("keeps the 90-day clean-up of the other records", () => {
    expect(text).toContain("These records are deleted after 90 days.");
  });

  it("says the extension reads a page only when its icon is clicked, and what it sends", () => {
    expect(text).toContain("It reads a page only when you click its icon");
    expect(text).toMatch(
      /sends that page's address \(and the address the page gives as its own\), its title, a few of its meta tags .*the structured data the page publishes for search engines, and the text of the page's main content/,
    );
    // On a site without its own reader, the generic one sends the page's main content, which need
    // not be a job posting: the policy says so rather than promising only the posting.
    expect(text).not.toContain("the text of the posting that the extension's reader for that site picks out");
    expect(text).toContain("plus the text you selected, if you selected any");
    expect(text).toContain("only to your copy of the app");
  });

  it("lists what the extension keeps in the browser, and what the app keeps of it", () => {
    expect(text).toContain(
      "In the browser it keeps only its key, your app's address, and the name and email address of the account",
    );
    // chrome.storage.session: gone when the browser closes.
    expect(text).toContain(
      "Until the browser closes, it also keeps the job details you edited in it but haven't saved yet (for each tab) and a connection that is still being made.",
    );
    expect(text).toMatch(/The app keeps a hash of the key, the browser it was connected in/);
  });

  it("says how to revoke the extension", () => {
    expect(text).toMatch(/Revoke in Settings, under Chrome extension, or Disconnect in the extension, deletes that browser's key/);
  });

  it("names no contact address", () => {
    expect(text).not.toMatch(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i);
  });
});
