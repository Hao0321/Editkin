const pfxFile = process.env.HAO_WINDOWS_CERTIFICATE_FILE;
const pfxPassword = process.env.HAO_WINDOWS_CERTIFICATE_PASSWORD;
const signToolPath = process.env.HAO_WINDOWS_SIGNTOOL_PATH;
const signWithParams = process.env.HAO_WINDOWS_SIGN_PARAMS;

if ((pfxFile && !pfxPassword) || (!pfxFile && pfxPassword)) throw new Error("HAO Windows PFX 簽章需要 certificate file 與 password 同時存在");
if ((signToolPath && !signWithParams) || (!signToolPath && signWithParams)) throw new Error("HAO 自訂／雲端簽章需要 signtool path 與 params 同時存在");
if (pfxFile && signToolPath) throw new Error("PFX 與自訂簽章模式不可同時啟用");

const windowsSign = signToolPath ? {
  signToolPath,
  signWithParams,
  timestampServer: process.env.HAO_WINDOWS_TIMESTAMP_URL ?? "http://timestamp.acs.microsoft.com",
  hashes: ["sha256"],
} : undefined;
const squirrelSigning = pfxFile ? { certificateFile: pfxFile, certificatePassword: pfxPassword } : windowsSign ? { windowsSign } : {};

module.exports = {
  packagerConfig: {
    asar: true,
    name: "Editkin",
    executableName: "Editkin",
    ...(windowsSign ? { windowsSign } : {}),
    extraResource: [".desktop-resources/runtime", ".desktop-resources/creative-packs", ".desktop-resources/personal-packs", ".desktop-resources/font-packs", ".desktop-resources/color", ".desktop-resources/plugins"],
    ignore: [
      /^\/src($|\/)/,
      /^\/electron($|\/)/,
      /^\/scripts($|\/)/,
      /^\/public($|\/)/,
      /^\/native\/hao-core($|\/)/,
      /^\/reports($|\/)/,
      /^\/vendor($|\/)/,
      /^\/spikes($|\/)/,
      /^\/\.desktop-resources($|\/)/,
      /^\/\.desktop-product-release-candidates($|\/)/,
      /^\/dev-server/,
    ],
  },
  makers: [
    { name: "@electron-forge/maker-squirrel", config: { name: "editkin", authors: "Hao0321 Studio", description: "Human taste. Agent speed.", ...squirrelSigning } },
    { name: "@electron-forge/maker-zip", platforms: ["win32"] },
  ],
};
