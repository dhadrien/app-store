import env from "@/src/environments";
import { GoogleSpreadsheetStore, Store } from "@/src/libs/store";
import {
  AuthType,
  SismoConnect,
  SismoConnectResponse,
  SismoConnectConfig,
  SismoConnectVerifiedResult,
} from "@sismo-core/sismo-connect-server";
import { NextResponse } from "next/server";
import { mapAuthTypeToSheetColumnName } from "@/src/utils/mapAuthTypeToSheetColumnName";
import { getSpace } from "@/src/libs/spaces";
import { getImpersonateAddresses } from "@/src/utils/getImpersonateAddresses";
import { ZkAppType, ZkFormAppType } from "@/src/libs/spaces/types";

const spreadSheetsInitiated = new Map<string, boolean>();

export async function POST(req: Request) {
  const { fields, response, spaceSlug, appSlug } = await req.json();
  const space = getSpace({ slug: spaceSlug });
  const app = space.apps.find((_app) => _app.type === "zkForm" && _app.slug === appSlug);

  if (app.type !== "zkForm")
    return new Response(null, {
      status: 500,
      statusText: "Verify not available for other apps than zkForm",
    });

  const store = await getStore(app);

  let fieldsToAdd = fields;

  const result = await verifyResponse(app, response);
  if (!result) return new Response(null, { status: 500, statusText: "Invalid response" });

  if (!app.saveAuths && needVaultAuth(app)) {
    const vaultId = await result.getUserId(AuthType.VAULT);
    if (!vaultId) return new Response(null, { status: 500, statusText: "No Vault Id" });
    fieldsToAdd = [
      ...fieldsToAdd,
      {
        name: "VaultId",
        value: vaultId,
      },
    ];
    if (!env.isDemo) {
      const isExist = await isVaultIdExist(store, vaultId);
      if (isExist) return NextResponse.json({ status: "already-subscribed" });
    }
  }

  if (app.saveAuths && app.authRequests?.length > 0) {
    for (let authRequest of app.authRequests) {
      const userId = await result.getUserId(authRequest.authType);
      if (!userId && !authRequest.isOptional)
        return new Response(null, { status: 500, statusText: `No ${authRequest.authType} Id` });

      if (!env.isDemo) {
        if (authRequest.authType === AuthType.VAULT) {
          const isExist = await isVaultIdExist(store, userId);
          if (isExist) return NextResponse.json({ status: "already-subscribed" });
        }
      }

      fieldsToAdd = [
        ...fieldsToAdd,
        {
          name: mapAuthTypeToSheetColumnName(authRequest.authType),
          value: userId,
        },
      ];
    }
  }

  if (app.saveClaims && app.claimRequests?.length > 0) {
    for (let claimRequest of app.claimRequests) {
      if (!claimRequest.isSelectableByUser) claimRequest.isSelectableByUser = false;
      const claim = result.claims.find(
        (claim) =>
          claim.groupId === claimRequest.groupId &&
          claim.claimType === claimRequest.claimType &&
          claim.groupTimestamp === claimRequest.groupTimestamp &&
          claim.isSelectableByUser === claimRequest.isSelectableByUser
      );
      fieldsToAdd = [
        ...fieldsToAdd,
        {
          name: claim.groupId,
          value: claim.value,
        },
      ];
    }
  }

  await store.add(fieldsToAdd);

  return NextResponse.json({
    status: "subscribed",
  });
}

const getStore = async (app: ZkFormAppType): Promise<Store> => {
  const appColumns = app?.fields ? app?.fields.map((el) => el.label) : [];

  let authColumns = needVaultAuth(app) ? ["VaultId"] : [];
  if (app.saveAuths)
    authColumns = app.authRequests.map((authRequest) =>
      mapAuthTypeToSheetColumnName(authRequest.authType)
    );

  let claimColumns = [];
  if (app.saveClaims) claimColumns = app.claimRequests.map((claimRequest) => claimRequest.groupId);

  const columns = [...authColumns, ...claimColumns, ...appColumns];

  const spreadsheetId = app.spreadsheetId;
  const store = new GoogleSpreadsheetStore({
    spreadsheetId,
    columns,
  });
  if (!spreadSheetsInitiated.has(app.spreadsheetId)) {
    await store.init();
    spreadSheetsInitiated.set(app.spreadsheetId, true);
  }
  return store;
};

const needVaultAuth = (app: ZkFormAppType): boolean => {
  if (!app.authRequests) return null;
  const authRequest = app.authRequests.find((el) => el.authType === AuthType.VAULT);
  return Boolean(authRequest);
};

const isVaultIdExist = async (store: Store, vaultId: string): Promise<boolean> => {
  const line = await store.get({ name: "VaultId", value: vaultId });
  return Boolean(line);
};

const verifyResponse = async (
  app: ZkFormAppType,
  response: SismoConnectResponse
): Promise<SismoConnectVerifiedResult> => {
  try {
    const config: SismoConnectConfig = {
      appId: env.isDev ? "0x4c40e70b081752680ce258ad321f9e58" : app.appId
    };

    if (env.isDemo) {
      config.vault = {
        impersonate: getImpersonateAddresses(app as ZkAppType)
      }
    }

    const sismoConnect = SismoConnect({ config });
    return await sismoConnect.verify(response, {
      claims: app.claimRequests,
      auths: app.authRequests,
    });
  } catch (e) {
    console.log("error", e);
  }
  return null;
};
