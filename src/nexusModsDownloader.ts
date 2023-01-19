import Nexus from 'nexus-api';
import { actions, log, selectors, types, util } from 'vortex-api';
import { IGameSupport } from './types';
import { getGameStore, ignoreNotifications } from './util';


const storeName = (id: string) => {
    switch(id) {
        case 'gog': return 'GOG';
        case 'epic': return 'Epic Games';
        case 'xbox': return 'Xbox Game Pass';
        case 'steam': return 'Steam';
        default: return 'Unknown Game Store';
    }
}

async function promptInstall(api: types.IExtensionApi, gameSupport: IGameSupport, gameId: string, version: string, store: string) {
    
    return new Promise<void>(((resolve, reject) => {
        api.sendNotification?.({
            id: `scriptextender-missing-${gameId}`,
            type: 'info',
            noDismiss: false,
            allowSuppress: true,
            title: 'Script Extender not installed',
            message: gameSupport.name,
            replace: { name: gameSupport.name },
            actions: [
                {
                    title: 'More',
                    action: (dismiss) =>  api.showDialog?.('info', '{{name}} not found', {
                        text: 'Vortex could not detect {{name}}. This means it is either not installed or installed incorrectly.'
                        + '\n\nFor the best modding experience, we recommend downloading and installing the script extender.'
                        + '\n\nYou are running version {{version}} ({{store}}) of the game, please make sure you use the correct script extender version.'
                        + '\n\nIf you ignore this notice, Vortex will not remind you again until it is restarted.',
                        parameters: { name: gameSupport.name, version: version || '?.?.?', store: storeName(store) },
                      },
                      [{
                        label: 'Ignore',
                        action: () => {
                          ignoreNotifications(gameSupport);
                          dismiss()
                          return reject(new util.UserCanceled());
                        },
                      },
                      {
                        label: 'Download',
                        action: () => {
                          resolve();
                          dismiss();
                        },
                      },]
                    )
                }
            ]
        })
    }));
}

export async function downloadScriptExtender(api: types.IExtensionApi, gameSupport:IGameSupport) {
    const state: types.IState = api.getState();
    const gameId: string = gameSupport.gameId;
    const discovery = selectors.discoveryByGame(state, gameId);
    const game = await util.getGame(gameId);
    if (game === undefined) {
        // this was possible in an earlier version because gameId was determined by fetching the id
        // of the active game and in rare cases that might be undefined by this point.
        // Since that is fixed, game should never be undefined
        return;
    }
    const version: string = game.getInstalledVersion?.(discovery);
    // Break off the final part of the version as we don't need it.
    const versionBasic = version ? version.split('.').slice(0,3).join('.') : undefined;
    const gameStore = getGameStore(gameId, api);

    try {
        // Ask the user if they want to install it.
        await promptInstall(api, gameSupport, gameId, versionBasic, gameStore);
        // If yes, start installing.
        const modId = await startDownload(api, gameSupport, gameId, versionBasic);
        // Force-deploy the xSE files
        if (modId) await api.emitAndAwait('deploy-single-mod', gameId, modId, true);
        // Refresh the tools dashlet
        await api.emitAndAwait('discover-tools', gameId);
        // Configure the primary tool. 
        api.store?.dispatch(
            { type: 'SET_PRIMARY_TOOL', 
              payload: { 
                gameId: gameId, 
                toolId: gameSupport.toolId
              } 
            }
        );
    
    }
    catch(err) {
        if (err instanceof util.UserCanceled || err instanceof util.ProcessCanceled) {
            return Promise.resolve();
        }
        else {
            api.showErrorNotification?.('Unable to download/install script extender', err);
            return Promise.resolve();
        }

    }
    
}

async function startDownload(
    api: types.IExtensionApi, 
    gameSupport: IGameSupport, 
    gameId: string,
    gameVersion?: string,
) {
    if (!gameSupport.nexusMods) return Promise.reject(new util.ArgumentInvalid('Game entry invalid or missing Nexus Mods info'))
    
    const nexusModsGameId = gameSupport.nexusMods?.gameId;
    const nexusModsModId = gameSupport.nexusMods?.modId;
    const state = api.getState();
    const nexusInfo: any = util.getSafe(state, ['persistent', 'nexus', 'userInfo'], undefined);
    const APIKEY: string = util.getSafe(state, ['confidential', 'account', 'nexus', 'APIKey'], undefined);

    // Free users or logged out users should be directed to the website.
    const modPageURL = `https://www.nexusmods.com/${gameSupport.nexusMods?.gameId}/mods/${gameSupport.nexusMods?.modId}?tab=files`;
    
    // If the user is logged out, all we can do is open the web page.
    if (!nexusInfo || !APIKEY) return util.opn(modPageURL).catch(() => null);
    
    // Use the Nexus Mods API to get the file ID. 
    const nexus = new Nexus('Vortex', util.getApplication().version, gameId, 30000);
    await nexus.setKey(APIKEY);
    let fileId: number = -1;
    try {
        const allModFiles = await nexus.getModFiles(nexusModsModId, nexusModsGameId).catch(() => ({ files: [], file_updates: [] }));
        if (!allModFiles.files.length) throw new util.DataInvalid('Unable to get a list of files from the API');
        // Look for either files that include the game version in the description or the primary file.
        let modFiles = allModFiles.files
            .filter(f => (!!gameVersion && !!f.description && f.description.includes(gameVersion)) || (!f.description && f.is_primary));
        // We found more than one relevant file!
        if (modFiles.length > 1) {
            modFiles.sort((a,b) => b.uploaded_timestamp - a.uploaded_timestamp);
        }
        let modFile = modFiles[0];
        if (!modFile) {
            // Exit here are just open the mod page.
            const fileChoices = allModFiles.files.filter(m => !!m.category_name).sort((a,b) => b.uploaded_timestamp - a.uploaded_timestamp).slice(0, 5);
            const gameStore = getGameStore(gameId, api);
            // For some weird reason, New Vegas has a tab character in the middle of it's name, so that needs to be removed. 
            const title = (selectors.gameById(api.getState(), gameId)?.name || 'game').replace('\t', ' ');
            const userChoice: types.IDialogResult = await api.showDialog('question', 'Select script extender version', {
                text: api.translate(
                    'Vortex could not automatically determine the correct version of {{name}} for your game. \n\n'+
                    'You have {{title}} version {{version}} installed from {{store}}.\n\n'+
                    'Please select the file you wish to download below.', { name: gameSupport.name, version: gameVersion, store: storeName(gameStore), title }),
                choices: fileChoices.map((m, idx) => ({ id: m.file_id.toString(), text: `Version ${m.version} ${m.description ? `- ${m.description}` : ''}`, value: (idx === 0)  })),
                links: [ { label: 'Can\'t see the right version? Visit the mod page.', action: () => util.opn(modPageURL).catch(() => null) } ]
            }, [
                {
                    label: 'Cancel'
                },
                {
                    label: 'Download'
                }
            ]);
            // User cancelled the process.
            if (userChoice.action === 'Cancel') throw new util.UserCanceled();
            // Work out which option was selected
            const selected: [string, any][] = Object.entries(userChoice.input).filter(i => i[1] === true);
            // User did not select an option.
            if (selected.length !== 1) throw new util.DataInvalid('Could not determine which file from Nexus Mods is the relevant SKSE build.');
            const idToUse = selected[0][0];
            // Resolve the modfile from the chosen option.
            const id = parseInt(idToUse);
            modFile = modFiles.find(m => m.file_id === id);
            // If somehow we've still failed to find the ID. 
            if (!modFile) throw new util.DataInvalid('Failed to match file ID to a valid file.');
        }
        fileId = modFile?.file_id;
    }
    catch(err) {
        if (err instanceof util.UserCanceled) return;
        log('error', `Could not obtain script extender file ID for ${gameSupport.name}. Opening mod page as a fallback.`, err);
        return util.opn(modPageURL).catch(() => null);
    }

    
    // Direct non-Premium users to the download page. 
    if (!nexusInfo?.isPremium) {
        const modFileURL = `${modPageURL}${fileId !== -1 ? `&file_id=${fileId}`: ''}`
        return util.opn(modFileURL).catch(() => null);
    }
    // We can start the download automatically for Premium users.
    else {
        const nxm = `nxm://${nexusModsGameId}/mods/${nexusModsModId}/files/${fileId}`;
        return new Promise<string>((resolve, reject) => {
            api.events.emit('start-download', [nxm], { game: gameId, name: gameSupport.name }, undefined,
            (err: Error, id: string) => {
                if (err) return reject(err);
                api.events.emit('start-install-download', id, undefined, 
                (err: Error, modId: string) => {
                    if (err) return reject(err);
                    const profileId = selectors.lastActiveProfileForGame(api.getState(), gameId);
                    api.store?.dispatch(actions.setModEnabled(profileId, modId, true));
                    return resolve(modId);
                }
                );
            }, 'replace'
            );
        });
    }

}