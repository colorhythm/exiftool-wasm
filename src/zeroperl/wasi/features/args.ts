import { WASIAbi } from "../abi";
import type { WASIOptions } from "../options";

/**
 * A feature provider that provides `args_get` and `args_sizes_get`
 */
export function useArgs(options: WASIOptions, abi: WASIAbi, memoryView: () => DataView): WebAssembly.ModuleImports {
    const args = options.args || [];
    return {
        args_get: (argv: number, argvBuf: number) => {
            const view = memoryView();
            abi.writeStringArray(view, args, argv, argvBuf);
            return WASIAbi.WASI_ESUCCESS;
        },
        args_sizes_get: (argc: number, argvBufSize: number) => {
            const view = memoryView();
            view.setUint32(argc, args.length, true);
            const sizes = abi.stringArraySize(args);
            view.setUint32(argvBufSize, sizes.bufferSize, true);
            return WASIAbi.WASI_ESUCCESS;
        },
    };
}