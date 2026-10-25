/*
 * Arsin Print Server - printer transport layer.
 *
 * All transports (UART, USB host, Bluetooth SPP, BLE) funnel into one queue and
 * one status object so the REST API, the raw 9100 server and the Bluetooth
 * front ends all report identical state.  printerWrite() never blocks: it
 * appends to a fixed ring buffer that printerLoop() drains in small slices, so
 * loop() stays watchdog friendly and no delay() ever exceeds 50 ms.
 */
#ifndef ARSIN_PRINTER_H
#define ARSIN_PRINTER_H

#include <stddef.h>
#include <stdint.h>

enum ArsinPrinterState { ARSIN_STATE_IDLE = 0, ARSIN_STATE_PRINTING = 1, ARSIN_STATE_ERROR = 2 };
enum ArsinPrinterHealth { ARSIN_HEALTH_OK = 0, ARSIN_HEALTH_OFFLINE = 1, ARSIN_HEALTH_PAPER_OUT = 2,
                          ARSIN_HEALTH_COVER_OPEN = 3, ARSIN_HEALTH_ERROR = 4 };

/** Initialise the configured transport(s).  Safe to call again after a config
 *  change: it tears the previous transport down first. */
bool printerBegin();
/** Drain the queue towards the active transport and collect replies. */
void printerLoop();
/** Force a status query (used by the console and the SSE loop). */
void printerRequestStatus();

/** Queue bytes for printing.  Returns the number of bytes accepted (0 when the
 *  queue is full - the caller reports back pressure). */
size_t printerWrite(const uint8_t* data, size_t len);
/** Write with back pressure: pumps the queue until everything is accepted or
 *  `timeoutMs` elapsed.  Safe to call from loop() context. */
size_t printerWriteAll(const uint8_t* data, size_t len, uint32_t timeoutMs);
size_t printerQueueDepth();
size_t printerQueueCapacity();
void printerQueueFlush();

ArsinPrinterState printerState();
ArsinPrinterHealth printerHealth();
const char* printerHealthName();
const char* printerStateName();
/** Name of the transport that currently owns the queue: uart|usbhost|bt|ble. */
const char* printerActiveTransport();
/** Configured transport as requested by the config file. */
const char* printerConfiguredTransport();
bool printerConnected();
const char* printerLastReply();

uint32_t printerJobs();
uint32_t printerBytes();
uint32_t printerErrors();
void printerCountersReset();
void printerCountJob(const char* jobId);
const char* printerLastJobId();
void printerSetError(const char* reason);
void printerClearError();

/* --- transport specific entry points (compiled in only when available) --- */
bool printerUartBegin();
void printerUartLoop();
size_t printerUartWrite(const uint8_t* data, size_t len);
size_t printerUartRead(uint8_t* out, size_t cap);

bool printerBtBegin();
void printerBtLoop();
bool printerBtConnected();
const char* printerBtName();
size_t printerBtWrite(const uint8_t* data, size_t len);
/** Called by the BT/BLE layer for every received chunk. */
void printerBtOnReceive(const uint8_t* data, size_t len);

bool printerUsbBegin();
void printerUsbLoop();
bool printerUsbConnected();
size_t printerUsbWrite(const uint8_t* data, size_t len);
void printerUsbDescribe(char* vid, size_t vidCap, char* pid, size_t pidCap,
                        char* manufacturer, size_t mfgCap, char* product, size_t prodCap);

#endif /* ARSIN_PRINTER_H */
