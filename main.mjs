import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import chalk from "chalk";
import { Command } from "commander";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import unzip from "unzip-stream";

const AUTH_KEY = "9u7qab84rpc16gvk";
const FUS_URL = "https://neofussvr.sslcs.cdngc.net";
const NONCE_KEY = "vicopx7dqu06emacgpnpy8j8zwhduwlh";

const builder = new XMLBuilder({});
const parser = new XMLParser();

const decryptNonce = (nonceEncrypted) => {
  const nonceDecipher = crypto.createDecipheriv(
    "aes-256-cbc",
    NONCE_KEY,
    NONCE_KEY.slice(0, 16),
  );
  return (
    nonceDecipher.update(nonceEncrypted, "base64", "utf-8") +
    nonceDecipher.final("utf-8")
  );
};

const getAuthorization = (nonceDecrypted) => {
  const key =
    Array.from(
      { length: 16 },
      (_, i) => NONCE_KEY[nonceDecrypted.charCodeAt(i) % 16],
    ).join("") + AUTH_KEY;

  const authCipher = crypto.createCipheriv(
    "aes-256-cbc",
    key,
    key.slice(0, 16),
  );
  return (
    authCipher.update(nonceDecrypted, "utf8", "base64") +
    authCipher.final("base64")
  );
};

const handleAuthRotation = (nonceEncrypted) => {
  const nonceDecrypted = decryptNonce(nonceEncrypted);
  return {
    Authorization: `FUS nonce="${nonceEncrypted}", signature="${getAuthorization(
      nonceDecrypted,
    )}", nc="", type="", realm="", newauth="1"`,
    nonceDecrypted,
    nonceEncrypted,
  };
};

const extractSessionIDFromCookies = (cookies) => {
  return (
    cookies?.find((cookie) => cookie.startsWith("JSESSIONID"))?.split(";")[0] ||
    null
  );
};

const updateHeaders = (responseHeaders, headers, nonceState) => {
  const { nonce } = responseHeaders;
  if (nonce) {
    const { Authorization, nonceDecrypted, nonceEncrypted } =
      handleAuthRotation(nonce);
    nonceState.decrypted = nonceDecrypted;
    nonceState.encrypted = nonceEncrypted;
    headers.Authorization = Authorization;
  }
  const sessionID = extractSessionIDFromCookies(responseHeaders["set-cookie"]);
  if (sessionID) headers.Cookie = sessionID;
};

const buildXMLMsg = (msgType, data) => {
  return builder.build({
    FUSMsg: {
      FUSHdr: { ProtoVer: "1.0" },
      FUSBody: { Put: { ...data } },
    },
  });
};

const getBinaryMsg = (type, data, nonce) => {
  const payload =
    type === "init"
      ? {
          BINARY_FILE_NAME: { Data: data },
          LOGIC_CHECK: {
            Data: getLogicCheck(data.split(".")[0].slice(-16), nonce),
          },
        }
      : {
          ACCESS_MODE: { Data: 2 },
          BINARY_NATURE: { Data: 1 },
          CLIENT_PRODUCT: { Data: "Smart Switch" },
          CLIENT_VERSION: { Data: "4.3.24062_1" },
          DEVICE_IMEI_PUSH: { Data: data.imei },
          DEVICE_FW_VERSION: { Data: data.version },
          DEVICE_LOCAL_CODE: { Data: data.region },
          DEVICE_MODEL_NAME: { Data: data.model },
          LOGIC_CHECK: { Data: getLogicCheck(data.version, nonce) },
          ...(data.region === "EUX"
            ? {
                DEVICE_AID_CODE: { Data: data.region },
                DEVICE_CC_CODE: { Data: "DE" },
                MCC_NUM: { Data: "262" },
                MNC_NUM: { Data: "01" },
              }
            : data.region === "EUY"
              ? {
                  DEVICE_AID_CODE: { Data: data.region },
                  DEVICE_CC_CODE: { Data: "RS" },
                  MCC_NUM: { Data: "220" },
                  MNC_NUM: { Data: "01" },
                }
              : {}),
        };
  return buildXMLMsg(type, payload);
};

const getLogicCheck = (input, nonce) => {
  return Array.from(nonce)
    .map((char) => input[char.charCodeAt(0) & 0xf])
    .join("");
};

const parseBinaryInfo = (data) => {
  const parsedInfo = parser.parse(data);
  const binaryInfo = {
    binaryByteSize: parsedInfo.FUSMsg.FUSBody.Put.BINARY_BYTE_SIZE.Data,
    binaryDescription: parsedInfo.FUSMsg.FUSBody.Put.DESCRIPTION.Data || "N/A",
    binaryFilename: parsedInfo.FUSMsg.FUSBody.Put.BINARY_NAME.Data,
    binaryLogicValue: parsedInfo.FUSMsg.FUSBody.Put.LOGIC_VALUE_FACTORY.Data,
    binaryModelPath: parsedInfo.FUSMsg.FUSBody.Put.MODEL_PATH.Data,
    binaryOSVersion: parsedInfo.FUSMsg.FUSBody.Put.CURRENT_OS_VERSION.Data,
    binaryVersion: parsedInfo.FUSMsg.FUSBody.Results.LATEST_FW_VERSION.Data,
  };

  console.log(chalk.blue(`Binary Size: ${binaryInfo.binaryByteSize} bytes`));
  console.log(chalk.yellow(`Description: ${binaryInfo.binaryDescription}`));
  console.log(chalk.cyan(`Filename: ${binaryInfo.binaryFilename}`));
  console.log(chalk.magenta(`Logical Value: ${binaryInfo.binaryLogicValue}`));
  console.log(chalk.green(`Model Path: ${binaryInfo.binaryModelPath}`));
  console.log(chalk.blue(`OS Version: ${binaryInfo.binaryOSVersion}`));
  console.log(chalk.yellow(`Binary Version: ${binaryInfo.binaryVersion}`));

  return binaryInfo;
};

const parseLatestFirmwareVersion = (data) => {
  const parsedData = parser.parse(data);
  const [pda, csc, modem] =
    parsedData.versioninfo.firmware.version.latest.split("/");
  return { pda, csc, modem };
};

const getDecryptionKey = (version, logicalValue) => {
  return crypto
    .createHash("md5")
    .update(getLogicCheck(version, logicalValue))
    .digest();
};

const getLatestFirmwareVersion = async (model, region) => {
  console.log(chalk.yellow("Fetching latest firmware version..."));
  const response = await axios.get(
    `http://fota-cloud-dn.ospserver.net/firmware/${region}/${model}/version.xml`,
  );
  return parseLatestFirmwareVersion(response.data);
};

const downloadFirmware = async (model, region, imei, latestFirmware) => {
  const { pda, csc, modem } = latestFirmware;
  const nonceState = { encrypted: "", decrypted: "" };
  const headers = { "User-Agent": "Kies2.0_FUS" };

  console.log(chalk.green("Fetching nonce..."));
  const nonceResponse = await axios.post(
    `${FUS_URL}/NF_DownloadGenerateNonce.do`,
    "",
    {
      headers: {
        Authorization:
          'FUS nonce="", signature="", nc="", type="", realm="", newauth="1"',
        "User-Agent": "Kies2.0_FUS",
      },
    },
  );
  updateHeaders(nonceResponse.headers, headers, nonceState);

  console.log(chalk.yellow("Fetching binary info..."));
  const binaryInfoResponse = await axios.post(
    `${FUS_URL}/NF_DownloadBinaryInform.do`,
    getBinaryMsg(
      "inform",
      { imei, version: `${pda}/${csc}/${modem}/${pda}`, region, model },
      nonceState.decrypted,
    ),
    { headers: { ...headers, "Content-Type": "application/xml" } },
  );
  updateHeaders(binaryInfoResponse.headers, headers, nonceState);

  const binaryInfo = parseBinaryInfo(binaryInfoResponse.data);
  const decryptionKey = getDecryptionKey(
    binaryInfo.binaryVersion,
    binaryInfo.binaryLogicValue,
  );

  console.log(chalk.green("Initializing binary download..."));
  const initResponse = await axios.post(
    `${FUS_URL}/NF_DownloadBinaryInitForMass.do`,
    getBinaryMsg("init", binaryInfo.binaryFilename, nonceState.decrypted),
    { headers: { ...headers, "Content-Type": "application/xml" } },
  );
  updateHeaders(initResponse.headers, headers, nonceState);

  const binaryDecipher = crypto.createDecipheriv(
    "aes-128-ecb",
    decryptionKey,
    null,
  );
  const res = await axios.get(
    `http://cloud-neofussvr.samsungmobile.com/NF_DownloadBinaryForMass.do?file=${binaryInfo.binaryModelPath}${binaryInfo.binaryFilename}`,
    { headers, responseType: "stream" },
  );

  const outputFolder = `${process.cwd()}/${model}_${region}/`;
  fs.mkdirSync(outputFolder, { recursive: true });

  let downloadedSize = 0;
  let lastProgress = 0;

  res.data
    .on("data", (buffer) => {
      downloadedSize += buffer.length;
      const downloadedGB = (downloadedSize / (1024 * 1024 * 1024)).toFixed(2);
      const totalSizeInGB = (
        binaryInfo.binaryByteSize /
        (1024 * 1024 * 1024)
      ).toFixed(2);
      const progress = ((downloadedGB / totalSizeInGB) * 100).toFixed(2);

      if (progress !== lastProgress) {
        process.stdout.write(
          chalk.cyan(
            `Downloading ${downloadedGB} / ${totalSizeInGB} GB = ${progress}%\r`,
          ),
        );
        lastProgress = progress;
      }
    })
    .pipe(binaryDecipher)
    .pipe(unzip.Parse())
    .on("entry", (entry) => {
      const filePath = path.join(outputFolder, entry.path);
      entry.pipe(fs.createWriteStream(filePath)).on("finish", () => {
        if (downloadedSize === binaryInfo.binaryByteSize) {
          console.log(chalk.green("Download completed."));
        }
      });
    });
};

const program = new Command();

program
  .requiredOption("-m, --model <model>", "Model")
  .requiredOption("-r, --region <region>", "Region")
  .requiredOption("-i, --imei <imei>", "IMEI/Serial Number")
  .parse(process.argv);

const options = program.opts();

(async () => {
  const latestFirmware = await getLatestFirmwareVersion(
    options.model,
    options.region,
  );
  await downloadFirmware(
    options.model,
    options.region,
    options.imei,
    latestFirmware,
  );
})();
