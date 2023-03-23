import { trace } from "./trace";
import { spawn } from "child_process";
import * as split2 from "split2";

import { Move } from "./types";
import { decodeMoves } from "goban/src/GoMath";
import { config } from "./config";
import { Pv } from "./Pv";
import type { Game } from "./Game";
import type { Connection } from "./Connection";

const gtpCommandEndRegex = new RegExp("(\\r?\\n){2}$");
const gtpCommandSplitRegex = new RegExp("(\\r?\\n){2}");

type cb_type = (output?: string) => void;
type eb_type = (err?: any) => void;

/*********/
/** Bot **/
/*********/
export class Bot {
    conn: Connection;
    game: Game;

    commands_sent: number;
    command_callbacks: Array<cb_type>;
    command_error_callbacks: Array<eb_type>;
    firstmove: boolean;
    ignore: boolean;
    dead: boolean;
    failed: boolean;
    pv: Pv;
    proc: ReturnType<typeof spawn>;
    kgstime: boolean;
    katafischer: boolean;
    katatime: boolean;
    json_initialized: boolean;
    is_resign_bot: boolean;

    constructor(conn: Connection, game: Game, cmd: string[], is_resign_bot: boolean = false) {
        this.conn = conn;
        this.game = game;
        this.commands_sent = 0;
        this.command_callbacks = [];
        this.command_error_callbacks = [];
        this.is_resign_bot = is_resign_bot;
        this.firstmove = true;
        this.ignore = false; // Ignore output from bot ?
        // Set to true when the bot process has died and needs to be restarted before it can be used again.
        this.dead = false;
        // Set to true when there is a command failure or a bot failure and the game fail counter should be incremented.
        // After a few failures we stop retrying and resign the game.
        this.failed = false;
        if (config.ogspv) {
            this.pv = new Pv(config.ogspv, game);
        }

        if (config.DEBUG) {
            this.log("Starting ", cmd.join(" "));
        }
        try {
            this.proc = spawn(cmd[0], cmd.slice(1));
        } catch (e) {
            this.log("Failed to start the bot: ", e);
            this.ignore = true;
            this.dead = true;
            this.failed = true;
            return;
        }

        this.proc.stderr.pipe(split2()).on("data", (data) => {
            if (this.ignore) {
                return;
            }
            const errline = data.toString().trim();
            if (errline === "") {
                return;
            }
            this.error(`stderr: ${errline}`);

            if (config.ogspv) {
                this.pv.postPvToChat(errline);
            }
            if (config.aichat) {
                const chat_match = /(DISCUSSION|MALKOVICH):(.*)/.exec(errline);
                if (chat_match) {
                    this.game.sendChat(
                        chat_match[2],
                        this.game.state.moves.length + 1,
                        chat_match[1].toLowerCase(),
                    );
                }
            }
        });

        let stdout_buffer = "";
        this.proc.stdout.on("data", (data) => {
            if (this.ignore) {
                return;
            }
            stdout_buffer += data.toString();

            if (config.json) {
                try {
                    stdout_buffer = JSON.parse(stdout_buffer);
                } catch (e) {
                    // Partial result received, wait until we can parse the result
                    return;
                }
            }

            if (!stdout_buffer || !gtpCommandEndRegex.test(stdout_buffer)) {
                //this.log("Partial result received, buffering until the output ends with a newline");
                return;
            }
            if (config.DEBUG) {
                this.log("<<<", stdout_buffer.trim());
            }

            const lines = stdout_buffer.split(gtpCommandSplitRegex);
            stdout_buffer = "";
            for (let i = 0; i < lines.length; ++i) {
                const line = lines[i];
                if (line.trim() === "") {
                    continue;
                }
                if (line[0] === "=") {
                    while (lines[i].trim() !== "") {
                        ++i;
                    }
                    const cb = this.command_callbacks.shift();
                    this.command_error_callbacks.shift(); // discard;
                    if (cb) {
                        cb(line.substring(1).trim());
                    }
                } else if (line.trim()[0] === "?") {
                    this.log(line);
                    while (lines[i].trim() !== "") {
                        ++i;
                        this.log(lines[i]);
                    }
                    this.failed = true;
                    this.command_callbacks.shift(); // discard;
                    const eb = this.command_error_callbacks.shift();
                    if (eb) {
                        eb(line.substring(1).trim());
                    }
                } else {
                    this.error("Unexpected output: ", line);
                    this.failed = true;
                    this.command_callbacks.shift(); // discard;
                    const eb = this.command_error_callbacks.shift();
                    if (eb) {
                        eb(line.trim());
                    }
                }
            }
        });
        this.proc.on("exit", (code) => {
            const unexpected = !this.dead;
            if (unexpected) {
                if (code) {
                    this.log("Bot exited", code);
                } else {
                    this.log("Bot exited");
                }
            }

            this.command_callbacks.shift(); // discard;
            this.dead = true;
            const eb = this.command_error_callbacks.shift();
            if (unexpected && eb) {
                eb(code);
            }
        });
        this.proc.stdin.on("error", (code) => {
            this.error("Bot stdin write error", code);
            this.command_callbacks.shift(); // discard;
            this.dead = true;
            this.failed = true;
            const eb = this.command_error_callbacks.shift();
            if (eb) {
                eb(code);
            }
        });
    }
    pid(): number {
        if (this.proc) {
            return this.proc.pid;
        } else {
            return -1;
        }
    }
    log(...arr: any[]): void {
        trace.log.apply(null, [
            `[${this.is_resign_bot ? "resign bot " : ""}${this.pid()}]`,
            ...arr,
        ]);
    }
    error(...arr: any[]): void {
        trace.error.apply(null, [
            `[${this.is_resign_bot ? "resign bot " : ""}${this.pid()}]`,
            ...arr,
        ]);
    }
    verbose(...arr: any[]): void {
        trace.verbose.apply(null, [
            `[${this.is_resign_bot ? "resign bot " : ""}${this.pid()}]`,
            ...arr,
        ]);
    }
    loadClock(state): void {
        /* References:
           http://www.lysator.liu.se/~gunnar/gtp/gtp2-spec-draft2/gtp2-spec.html#sec:time-handling
           http://www.weddslist.com/kgs/how/kgsGtp.html

           GTP v2 only supports Canadian Byoyomi, no timer (see spec above),
           and absolute (period time zero).

           kgs-time_settings adds support for Japanese Byoyomi.

           The kgsGtp interface (http://www.weddslist.com/kgs/how/kgsGtp.html)
           converts byoyomi to absolute time for bots that don't support
           kgs-time_settings by using main_time plus periods * period_time.
           But then the bot would view that as the total time left for entire rest of game...

           Japanese Byoyomi with one period left could be viewed as a special case
           of Canadian Byoyomi where the number of stones is always = 1
        */
        if (config.noclock) {
            return;
        }

        // clock_drift compensates for difference between server and client time, and latency.
        const now = Date.now() - this.conn.clock_drift;

        let black_offset = 0;
        let white_offset = 0;

        // offset indicates how long we've had since last move. Ogs only communicates how much
        // time the player had when last move was made.
        if (state.clock.current_player === state.clock.black_player_id) {
            black_offset =
                ((this.firstmove === true ? config.startupbuffer : 0) +
                    now -
                    state.clock.last_move) /
                1000;
        } else {
            white_offset =
                ((this.firstmove === true ? config.startupbuffer : 0) +
                    now -
                    state.clock.last_move) /
                1000;
        }

        if (state.time_control.system === "byoyomi") {
            let black_time = state.clock.black_time.thinking_time;
            let white_time = state.clock.white_time.thinking_time;
            let black_periods = state.clock.black_time.periods;
            let white_periods = state.clock.white_time.periods;
            let black_timeleft = 0;
            let white_timeleft = 0;

            if (this.kgstime) {
                if (black_time > 0) {
                    black_timeleft = black_time - black_offset;
                } else {
                    black_timeleft = state.time_control.period_time - black_offset;
                }

                if (white_time > 0) {
                    white_timeleft = white_time - white_offset;
                } else {
                    white_timeleft = state.time_control.period_time - white_offset;
                }

                // If we're so slow that time left - offset is negative, we need to roll over to period time.
                while (black_timeleft < 0 && black_periods > 1) {
                    black_timeleft += state.clock.black_time.period_time;
                    if (black_time > 0) {
                        black_time = 0;
                    } else {
                        black_periods--;
                    }
                }
                while (white_timeleft < 0 && white_periods > 1) {
                    white_timeleft += state.clock.white_time.period_time;
                    if (white_time > 0) {
                        white_time = 0;
                    } else {
                        white_periods--;
                    }
                }

                void this.command(
                    `kgs-time_settings byoyomi ${state.time_control.main_time} ${state.time_control.period_time} ${state.time_control.periods}`,
                );
                void this.command(
                    `time_left black ${Math.floor(Math.max(black_timeleft, 0))} ${
                        black_time > 0 ? "0" : black_periods
                    }`,
                );
                void this.command(
                    `time_left white ${Math.floor(Math.max(white_timeleft, 0))} ${
                        white_time > 0 ? "0" : white_periods
                    }`,
                );
            } else {
                /* Gtp does not support Japanese Byoyomi. We fake it as Canadian Byoyomi.
                   Let's pretend the final period is a Canadian Byoyomi of 1 stone.
                   This lets the bot know it can use the full period per move,
                   not try to fit the rest of the game into the time left.
                */
                // add all periods to the main time.
                // If we're already in overtime, exclude the current period.
                if (black_time > 0) {
                    black_timeleft =
                        black_time -
                        black_offset +
                        state.clock.black_time.period_time * black_periods;
                } else {
                    black_timeleft =
                        state.time_control.period_time -
                        black_offset +
                        state.clock.black_time.period_time * (black_periods - 1);
                }
                if (white_time > 0) {
                    white_timeleft =
                        white_time -
                        white_offset +
                        state.clock.black_time.period_time * black_periods;
                } else {
                    white_timeleft =
                        state.time_control.period_time -
                        white_offset +
                        state.clock.black_time.period_time * (black_periods - 1);
                }

                void this.command(
                    `time_settings ${
                        state.time_control.main_time +
                        (state.time_control.periods - 1) * state.time_control.period_time
                    } ${state.time_control.period_time} 1`,
                );
                // If we're in the last period, tell the bot. Otherwise pretend we're in main time.
                if (black_timeleft <= state.clock.black_time.period_time) {
                    void this.command(
                        `time_left black ${Math.floor(Math.max(black_timeleft, 0))} 1`,
                    );
                } else {
                    void this.command(
                        `time_left black ${Math.floor(
                            black_timeleft - state.clock.black_time.period_time,
                        )} 0`,
                    );
                }
                if (white_timeleft <= state.clock.white_time.period_time) {
                    void this.command(
                        `time_left white ${Math.floor(Math.max(white_timeleft, 0))} 1`,
                    );
                } else {
                    void this.command(
                        `time_left white ${Math.floor(
                            white_timeleft - state.clock.white_time.period_time,
                        )} 0`,
                    );
                }
            }
        } else if (state.time_control.system === "canadian") {
            /* Canadian Byoyomi is the only time controls GTP v2 officially supports.
             */
            let black_timeleft = state.clock.black_time.thinking_time - black_offset;
            let white_timeleft = state.clock.white_time.thinking_time - white_offset;
            let black_stones = 0;
            let white_stones = 0;

            if (black_timeleft <= 0) {
                black_stones = state.clock.black_time.moves_left;
                black_timeleft += state.clock.black_time.block_time;
            }
            if (white_timeleft <= 0) {
                white_stones = state.clock.white_time.moves_left;
                white_timeleft += state.clock.white_time.block_time;
            }

            if (this.kgstime) {
                void this.command(
                    `kgs-time_settings canadian ${state.time_control.main_time} ${state.time_control.period_time} ${state.time_control.stones_per_period}`,
                );
            } else {
                void this.command(
                    `time_settings ${state.time_control.main_time} ${state.time_control.period_time} ${state.time_control.stones_per_period}`,
                );
            }

            void this.command(
                `time_left black ${Math.floor(Math.max(black_timeleft, 0))} ${black_stones}`,
            );
            void this.command(
                `time_left white ${Math.floor(Math.max(white_timeleft, 0))} ${white_stones}`,
            );
        } else if (state.time_control.system === "fischer") {
            if (this.katafischer) {
                const black_timeleft = state.clock.black_time.thinking_time - black_offset;
                const white_timeleft = state.clock.white_time.thinking_time - white_offset;
                void this.command(
                    `kata-time_settings fischer-capped ${state.time_control.initial_time} ${state.time_control.time_increment} ${state.time_control.max_time} -1`,
                );
                void this.command(`time_left black ${Math.floor(Math.max(black_timeleft, 0))} 0`);
                void this.command(`time_left white ${Math.floor(Math.max(white_timeleft, 0))} 0`);
            } else {
                /* Not supported by kgs-time_settings and I assume most bots.
                   A better way than absolute is to handle this with
                   a fake Canadian Byoyomi. This should let the bot know
                   a good approximation of how to handle the time remaining.
                */
                let black_timeleft =
                    state.clock.black_time.thinking_time -
                    black_offset -
                    state.time_control.time_increment;
                let white_timeleft =
                    state.clock.white_time.thinking_time -
                    white_offset -
                    state.time_control.time_increment;
                let black_periods = 0;
                let white_periods = 0;

                if (this.kgstime) {
                    void this.command(
                        `kgs-time_settings canadian ${
                            state.time_control.initial_time - state.time_control.time_increment
                        } ${state.time_control.time_increment} 1`,
                    );
                } else {
                    void this.command(
                        `time_settings ${
                            state.time_control.initial_time - state.time_control.time_increment
                        } ${state.time_control.time_increment} 1`,
                    );
                }

                if (black_timeleft <= 0) {
                    black_periods = 1;
                    black_timeleft += state.time_control.time_increment;
                }
                if (white_timeleft <= 0) {
                    white_periods = 1;
                    white_timeleft += state.time_control.time_increment;
                }

                /* Always tell the bot we are in main time ('0') so it doesn't try
                  to think all of timeleft per move.
                  But subtract the increment time above to avoid timeouts.
               */
                void this.command(
                    `time_left black ${Math.floor(Math.max(black_timeleft, 0))} ${black_periods}`,
                );
                void this.command(
                    `time_left white ${Math.floor(Math.max(white_timeleft, 0))} ${white_periods}`,
                );
            }
        } else if (state.time_control.system === "simple") {
            /* Simple could also be viewed as a Canadian Byoyomi that starts
               immediately with # of stones = 1
            */

            // for some reason ogs sends a timestamp (equal to state.clock.last_move) instead of our time.
            // Luckely we can use state.time_control.per_move since simple time is always in overtime.
            const black_timeleft = state.time_control.per_move - black_offset;
            const white_timeleft = state.time_control.per_move - white_offset;

            void this.command(`time_settings 0 ${state.time_control.per_move} 1`);

            void this.command(`time_left black ${Math.floor(Math.max(black_timeleft, 0))} 1`);
            void this.command(`time_left white ${Math.floor(Math.max(white_timeleft, 0))} 1`);
        } else if (state.time_control.system === "absolute") {
            const black_timeleft = state.clock.black_time.thinking_time - black_offset;
            const white_timeleft = state.clock.white_time.thinking_time - white_offset;

            void this.command(`time_settings ${state.time_control.total_time} 0 0`);
            void this.command(`time_left black ${Math.floor(Math.max(black_timeleft, 0))} 0`);
            void this.command(`time_left white ${Math.floor(Math.max(white_timeleft, 0))} 0`);
        }
        /*  OGS doesn't actually send 'none' time control type
            else if (state.time_control.system === 'none') {
                if (this.kgstime) {
                    this.command("kgs-time_settings none");
                } else {
                    // GTP v2 says byoyomi time > 0 and stones = 0 means no time limits
                    //
                    this.command("time_settings 0 1 0");
                }
            }
        */
    }

    async loadState(state): Promise<string> {
        if (this.dead) {
            this.failed = true;
            this.error("Attempted to load state to a dead bot");
            throw new Error("Attempting to load dead bot");
        }

        const commands = await this.command("list_commands");
        this.kgstime = commands.includes("kgs-time_settings");
        this.katatime = commands.includes("kata-list_time_settings");
        if (this.katatime) {
            const kataTimeSettings = await this.command("kata-list_time_settings");
            this.katafischer = kataTimeSettings.includes("fischer-capped");
        } else {
            this.katafischer = false;
        }

        if (state.width === state.height) {
            await this.command(`boardsize ${state.width}`);
        } else {
            await this.command(`boardsize ${state.width} ${state.height}`);
        }
        await this.command("clear_board");
        await this.command(`komi ${state.komi}`);

        let have_initial_state = false;
        if (state.initial_state) {
            const black = decodeMoves(state.initial_state.black, state.width, state.height);
            const white = decodeMoves(state.initial_state.white, state.width, state.height);
            have_initial_state = !!black.length || !!white.length;

            for (let i = 0; i < black.length; ++i) {
                await this.command(
                    `play black ${move2gtpvertex(black[i], state.width, state.height)}`,
                );
            }
            for (let i = 0; i < white.length; ++i) {
                await this.command(
                    `play white ${move2gtpvertex(white[i], state.width, state.height)}`,
                );
            }
        }

        // Replay moves made
        let color = state.initial_player;
        const doing_handicap =
            !have_initial_state && state.free_handicap_placement && state.handicap > 1;
        const handicap_moves = [];
        const moves = decodeMoves(state.moves, state.width, state.height);
        for (let i = 0; i < moves.length; ++i) {
            const move = moves[i];

            // Use set_free_handicap for handicap stones, play otherwise.
            if (doing_handicap && handicap_moves.length < state.handicap) {
                handicap_moves.push(move);
                if (handicap_moves.length === state.handicap) {
                    void this.sendHandicapMoves(handicap_moves, state.width, state.height);
                } else {
                    continue;
                } // don't switch color.
            } else {
                await this.command(
                    `play ${color} ${move2gtpvertex(move, state.width, state.height)}`,
                );
            }

            color = color === "black" ? "white" : "black";
        }
        if (config.showboard) {
            return await this.command("showboard");
        }
        return "";
    }

    command(str: string, final_command?: boolean): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            if (this.dead) {
                this.error("Attempting to send a command to dead bot:", str);
                this.failed = true;
                reject(`Attempting to send a command to dead bot: ${str}`);
                return;
            }

            this.command_callbacks.push(resolve);
            this.command_error_callbacks.push(reject);
            if (config.DEBUG) {
                this.log(">>>", str);
            }
            try {
                if (config.json) {
                    if (!this.json_initialized) {
                        this.proc.stdin.write(`{"gtp_commands": [`);
                        this.json_initialized = true;
                    } else {
                        this.proc.stdin.write(",");
                    }
                    this.proc.stdin.write(JSON.stringify(str));
                    if (final_command) {
                        this.proc.stdin.write("]}");
                        this.proc.stdin.end();
                    }
                } else {
                    this.proc.stdin.write(`${str}\r\n`);
                }
            } catch (e) {
                // I think this does not normally happen, the exception will usually be raised in the async write handler
                // and delivered through an 'error' event.
                //
                this.error("Failed to send command: ", str);
                this.error(e);
                this.dead = true;
                this.failed = true;
                // Already calling the callback!
                this.command_error_callbacks.shift();
                reject(e);
                return;
            }
        });
    }

    // For commands like genmove, place_free_handicap ... :
    // Send @cmd to engine and call @cb with returned moves.
    // TODO: We may want to have a timeout here, in case bot crashes. Set it before this.command, clear it in the callback?
    //
    async getMoves(cmd, state): Promise<Move[]> {
        // Do this here so we only do it once, plus if there is a long delay between clock message and move message, we'll
        // subtract that missing time from what we tell the bot.
        //
        this.loadClock(state);

        // Only relevent with persistent bots. Leave the setting on until we actually have requested a move.
        // Must be after loadClock() since loadClock() checks this.firstmove!
        //
        this.firstmove = false;

        const line = await this.command(cmd, true /* final command */);

        const parts = line.toLowerCase().split(/ +/);
        const moves: Move[] = [];

        for (let i = 0; i < parts.length; i++) {
            const move = parts[i];

            let resign = move === "resign";
            const pass = move === "pass";
            let x = -1;
            let y = -1;
            if (!resign && !pass) {
                if (move && move[0]) {
                    x = gtpchar2num(move[0]);
                    y = state.height - parseInt(move.substring(1));
                } else {
                    this.log(`${cmd} failed, resigning`);
                    resign = true;
                }
            }
            moves.push({ x, y, text: move, resign, pass });
        }

        return moves;
    }

    kill() {
        this.log("Stopping bot");
        this.ignore = true; // Prevent race conditions / inconsistencies. Could be in the middle of genmove ...
        // "quit" needs to be sent before we toggle this.dead since command() checks the status of this.dead
        void this.command("quit");
        this.dead = true;
        if (this.proc) {
            this.proc.kill();
            setTimeout(() => {
                // To be 100% sure.
                if (config.DEBUG) {
                    this.log("Killing process directly with a signal");
                }
                this.proc.kill(9);
            }, 5000);
        }
    }
    async sendMove(move, width, height, color): Promise<void> {
        if (config.DEBUG) {
            this.log("Calling sendMove with", move2gtpvertex(move, width, height));
        }
        await this.command(`play ${color} ${move2gtpvertex(move, width, height)}`);
    }
    async sendHandicapMoves(moves, width, height): Promise<void> {
        let cmd = "set_free_handicap";
        for (let i = 0; i < moves.length; i++) {
            cmd += ` ${move2gtpvertex(moves[i], width, height)}`;
        }
        await this.command(cmd);
    }
    // Called on game over, in case you need something special.
    //
    gameOver() {}
}

export function gtpchar2num(ch: string): number {
    if (ch === "." || !ch) {
        return -1;
    }
    return "abcdefghjklmnopqrstuvwxyz".indexOf(ch.toLowerCase());
}

export function move2gtpvertex(move, width: number, height: number): string {
    if (move.x < 0) {
        return "pass";
    }
    return num2gtpchar(move["x"]) + (height - move["y"]);
}

function num2gtpchar(num: number): string {
    if (num === -1) {
        return ".";
    }
    return "abcdefghjklmnopqrstuvwxyz"[num];
}
