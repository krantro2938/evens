/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_MD_SERVER?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
