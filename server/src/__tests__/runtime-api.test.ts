import { describe, expect, it } from "vitest";
import { buildRuntimeApiCandidateUrls, choosePrimaryRuntimeApiUrl } from "../runtime-api.js";

describe("runtime API discovery", () => {
  it("prefers the explicit public base URL for the primary runtime URL", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: "https://paperclip.example.com/base/path",
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3102,
      }),
    ).toBe("https://paperclip.example.com");
  });

  it("swaps in the listen port when a portless http base URL names a host we serve", () => {
    // The exact shape that broke agents: `.env` carried
    // BETTER_AUTH_URL=http://paperclip.local while the server listened on
    // 3100, so every agent's REST call went to whatever owned port 80.
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: "http://paperclip.local",
        allowedHostnames: ["127.0.0.1", "paperclip.local"],
        bindHost: "0.0.0.0",
        port: 3100,
      }),
    ).toBe("http://paperclip.local:3100");
  });

  it("leaves an https base URL alone, because this server does not terminate its TLS", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: "https://paperclip.example.com",
        allowedHostnames: ["paperclip.example.com"],
        bindHost: "0.0.0.0",
        port: 3100,
      }),
    ).toBe("https://paperclip.example.com");
  });

  it("leaves a written-down port alone", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: "http://paperclip.local:8080",
        allowedHostnames: ["paperclip.local"],
        bindHost: "0.0.0.0",
        port: 3100,
      }),
    ).toBe("http://paperclip.local:8080");
  });

  it("leaves a hostname we do not serve alone, since the proxy is the only route in", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: "http://proxy.example.com",
        allowedHostnames: ["127.0.0.1", "paperclip.local"],
        bindHost: "0.0.0.0",
        port: 3100,
      }),
    ).toBe("http://proxy.example.com");
  });

  it("puts the corrected origin first in the candidate list too", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: "http://paperclip.local",
        allowedHostnames: ["paperclip.local", "127.0.0.1"],
        bindHost: "0.0.0.0",
        port: 3100,
        networkInterfacesMap: {},
      })[0],
    ).toBe("http://paperclip.local:3100");
  });

  it("builds ordered callback candidates from explicit, allowed, bind, and interface hosts", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: null,
        allowedHostnames: ["198.51.100.10", "runtime-host.example.test", "203.0.113.42"],
        bindHost: "0.0.0.0",
        port: 3102,
        networkInterfacesMap: {
          en0: [
            {
              address: "203.0.113.42",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "203.0.113.42/24",
              mac: "00:00:00:00:00:00",
            },
            {
              address: "fe80::1",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff:ffff::",
              cidr: "fe80::1/64",
              mac: "00:00:00:00:00:00",
              scopeid: 1,
            },
          ],
          lo0: [
            {
              address: "127.0.0.1",
              family: "IPv4",
              internal: true,
              netmask: "255.0.0.0",
              cidr: "127.0.0.1/8",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual([
      "http://198.51.100.10:3102",
      "http://runtime-host.example.test:3102",
      "http://203.0.113.42:3102",
      "http://[fe80::1]:3102",
    ]);
  });

  it("adds host.docker.internal when the explicit base URL is loopback", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: "http://127.0.0.1:3102",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        port: 3102,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "http://127.0.0.1:3102",
      "http://host.docker.internal:3102",
    ]);
  });
});
