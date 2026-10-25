/*
 * Arsin Print Server - on-device maintenance command builder.
 *
 * Builds the byte sequence for every action the web console can trigger, for
 * every printer language the catalog advertises.  The ESC/POS sequences are
 * byte identical to assets/js/core/commands.js so the browser preview and the
 * device agree.
 */
#ifndef ARSIN_COMMANDS_H
#define ARSIN_COMMANDS_H

#include <stddef.h>
#include <stdint.h>

/** Actions accepted by POST /api/command. */
const char* const* arsinCommandActions(size_t* count);
bool arsinCommandActionKnown(const char* action);
const char* const* arsinCommandLanguages(size_t* count);

/**
 * Build the byte sequence for `action` in `lang`.
 *
 * @param paramsJson optional JSON object with the action parameters
 *                   ({"lines":3,"cutter":"full","media":"gap","darkness":8,...}).
 * @return false when the language or action is unknown, or the buffer is full.
 */
bool arsinBuildCommand(const char* lang,
                       const char* action,
                       const char* paramsJson,
                       size_t paramsLen,
                       uint8_t* out,
                       size_t cap,
                       size_t* outLen,
                       char* note,
                       size_t noteCap);

/** Copies `count` copies of an already built sequence into `out`. */
bool arsinRepeatBytes(const uint8_t* src, size_t len, uint8_t copies, uint8_t* out, size_t cap, size_t* outLen);

#endif /* ARSIN_COMMANDS_H */
