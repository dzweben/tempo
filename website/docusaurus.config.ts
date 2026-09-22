import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import { themes as prismThemes } from "prism-react-renderer";

const GITHUB = "https://github.com/dzweben/tempo";

const config: Config = {
  title: "TEMPO",
  tagline: "Tracking, Engagement, Messaging & Participant Outreach",
  favicon: "img/favicon.svg",

  url: "https://dzweben.github.io",
  baseUrl: "/tempo/",
  organizationName: "dzweben",
  projectName: "tempo",
  trailingSlash: false,

  onBrokenLinks: "warn",

  markdown: { mermaid: true, hooks: { onBrokenMarkdownLinks: "warn" } },
  themes: ["@docusaurus/theme-mermaid"],

  i18n: { defaultLocale: "en", locales: ["en"] },

  presets: [
    [
      "classic",
      {
        docs: {
          path: "docs",
          routeBasePath: "docs",
          sidebarPath: "./sidebars.ts",
          editUrl: `${GITHUB}/tree/main/website/`,
          showLastUpdateTime: false,
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.png",
    colorMode: { defaultMode: "light", respectPrefersColorScheme: true },
    docs: { sidebar: { hideable: true, autoCollapseCategories: false } },
    navbar: {
      title: "TEMPO",
      logo: { alt: "TEMPO", src: "img/logo.svg", srcDark: "img/logo-dark.svg" },
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Documentation" },
        { to: "/docs/quickstart", label: "Quickstart", position: "left" },
        { to: "/docs/timeline-spec", label: "Timeline spec", position: "left" },
        { href: GITHUB, label: "GitHub", position: "right" },
      ],
    },
    footer: {
      style: "light",
      links: [
        {
          title: "Documentation",
          items: [
            { label: "What TEMPO is", to: "/docs/intro" },
            { label: "Architecture", to: "/docs/architecture" },
            { label: "Quickstart", to: "/docs/quickstart" },
            { label: "Timeline spec", to: "/docs/timeline-spec" },
          ],
        },
        {
          title: "Reference",
          items: [
            { label: "Delivery & safety rails", to: "/docs/delivery" },
            { label: "Data model", to: "/docs/data-model" },
            { label: "Dashboard", to: "/docs/dashboard" },
            { label: "Adapting to your study", to: "/docs/adapting" },
          ],
        },
        {
          title: "Project",
          items: [
            { label: "GitHub", href: GITHUB },
            { label: "Security & privacy", href: `${GITHUB}/blob/main/SECURITY.md` },
            { label: "License (MIT)", href: `${GITHUB}/blob/main/LICENSE` },
            { label: "Cite this software", href: `${GITHUB}/blob/main/CITATION.cff` },
          ],
        },
      ],
      copyright: `TEMPO — built by Danny Zweben, Temple University. Released under the MIT License.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "typescript", "yaml"],
    },
    mermaid: { theme: { light: "neutral", dark: "dark" } },
  } satisfies Preset.ThemeConfig,
};

export default config;
