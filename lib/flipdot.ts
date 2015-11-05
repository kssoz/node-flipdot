/// <reference path="typings/tsd.d.ts" />

import * as request from "request";

module flipdot
{
	const spaceStatusURL = "http://flipdot.org/spacestatus/status.json";
	const powerConsumptionURL = "http://infragelb.de/flipdot-power/";

	const hutschienenHost = "hutschienenpi.fd";
	const hutschienenPort = 8080;

	const canBusBase = `http://${hutschienenHost}:${hutschienenPort}`;
	const hutshieneClientName = "Hutschiene";
	const radiatorClientName = "theemin";

	export interface ISpaceStatus
	{
		open: boolean;
		known_users: IUser[];
		unknown_users: number;

		temperature_setpoint: number;
		temperature_realvalue: number;
		heater_valve: number;
	}

	export interface IPowerConsumption
	{
		/**
		 * Power consumption in Watts
		 * @type {number}
		 */
		consumption: number;
		timestamp: Date;
	}

	export interface IUser
	{
		nick: string;
	}

	export interface ITemperature
	{
		value: number;
		unit: string;
	}

	export interface ICallback<T>
	{
		(err: any, status: T): void;
	}

	export enum LightStatus
	{
		off = 0,
		on = 1
	}

	type RequestFunction = (url: string, callback: (err, res, body) => void) => void;
	type ParseFunction = (body: string) => void;

	function wrapWithTry<T>(fn: () => T): [Error, T]
	{
		try {
			return [null, fn()];
		} catch(ex) {
			return [ex, null];
		}
	}

	function doAndParseRequest<T>(request: RequestFunction, parser: (body: string) => [any, T], callback: ICallback<T>, url: string): void
	{
		let hadError = false;
		request(url, (err, res, body) => {
			if(!err && isSuccess(res))
			{
				if(hadError) // If request calls the callback although it already reported an error
					return; // avoid calling the callback twice.

				let [err, res] = parser ? parser(body) : [null, null];

				if(callback)
				{
					if(err)
						callback(err, null);
					else
						callback(null, res);
				}
			}
			else if(!!err)
			{
				hadError = true;
				if(callback)
					callback(err, null);
			}
		});
	}

	/**
	 * Switches the orange light on or off.
	 */
	export function setOrangeLightStatus(status: LightStatus, callback: ICallback<void>): void
	{
		let statusString = status == LightStatus.on ? "true" : "false";
		let orangeLightUrl = getCANUrl(hutshieneClientName, "OrangeLight");
		let statusUrl = `${orangeLightUrl}?state=${statusString}`;

		return doAndParseRequest(
			request.post,
			null,
			callback,
			statusUrl);
	}

	/**
	 * Gets the current temperature as measured by the sensor of the radiator control.
	 */
	export function getCurrentTemperature(callback: ICallback<ITemperature>): void
	{
		let serviceUrl = getCANUrl(radiatorClientName, "GetActTemp");

		return doAndParseRequest(
			request.get,
			body => wrapWithTry(() => parseTemperature(body)),
			callback,
			serviceUrl);
	}

	/**
	 * Gets the temperature that the radiator is set to.
	 */
	export function getTargetTemperature(callback: ICallback<ITemperature>): void
	{
		let serviceUrl = getCANUrl(radiatorClientName, "GetTargetTemp");

		return doAndParseRequest(
			request.get,
			body => wrapWithTry(() =>parseTemperature(body)),
			callback,
			serviceUrl);
	}

	/**
	 * Sets the target temperature of the radiator.
	 * @param {number} temperature The target temperature in celsius.
	 */
	export function setTargetTemperature(temperature: number, callback: ICallback<void>): void
	{
		// TODO: TEST THIS
		let opUrl = getCANUrl(radiatorClientName, "SetTargetTemp");
		let serviceUrl = `${opUrl}?temp=${temperature}`;

		return doAndParseRequest(
			request.post,
			null,
			callback,
			serviceUrl);
	}

	/**
	 * Retrieves the current status of the hackerspace.
	 * @param {ISpaceStatusCallback} callback The callback of the async operation.
	 */
	export function getSpaceStatus(callback: ICallback<ISpaceStatus>): void
	{
		return doAndParseRequest(
			request.get,
			body => wrapWithTry(() => {
				let status = JSON.parse(body);
				return fixStatus(status);
			}),
			callback,
			spaceStatusURL);
	}

	/**
	 * Get current power consumption in Watts.
	 */
	export function getPowerConsumption(callback: ICallback<IPowerConsumption>): void
	{
		return doAndParseRequest(
			request.get,
			body => wrapWithTry(() => parsePowerConsumption(body)),
			callback,
			powerConsumptionURL);
	}

	/**
	 * Internal method to normalize the return value of the API.
	 * @param  {ISpaceStatus} status The original return value.
	 * @return {ISpaceStatus}        The normalized result.
	 */
	function fixStatus(status: ISpaceStatus): ISpaceStatus
	{
		return {
			open: status.open || false,
			known_users: status.known_users || [],
			unknown_users: status.unknown_users || 0,
			temperature_setpoint: status.temperature_setpoint || 0,
			temperature_realvalue: status.temperature_realvalue || 0,
			heater_valve: status.heater_valve || 0
		};
	}

	function parsePowerConsumption(apiResponse: string): IPowerConsumption
	{
		if(!apiResponse || apiResponse.trim() == "")
			throw new Error("Empty API response.");

		var splitted = apiResponse.trim().split(",");
		if(!splitted || splitted.length !== 3)
			throw new Error("Invalid API response (malformed CSV).");

		// 27.01.2015,21:47:48,00438

		let dateStr = splitted[0].trim();
		let timeStr = splitted[1].trim();
		let consumptionStr = splitted[2].trim();

		let dateSplit = dateStr.split(".");
		let timeSplit = timeStr.split(":");

		if(dateSplit.length !== 3 || timeSplit.length !== 3)
			throw new Error("Invalid API response (malformed date/time).");

		// constructor for months takes 0-based months
		let timestamp = new Date(parseInt(dateSplit[2]), parseInt(dateSplit[1]) - 1, parseInt(dateSplit[0]),
								parseInt(timeSplit[0]), parseInt(timeSplit[1]), parseInt(timeSplit[2]), 0);

		return {
			timestamp: timestamp,
			consumption: parseInt(consumptionStr) /* may catch parse error here to throw specific exception */
		};
	}

	/**
	 * Parses a temperature response of the radiator client.
	 */
	function parseTemperature(responseBody: string): ITemperature
	{
		if (!responseBody || responseBody.trim() === "")
			throw new Error("Got empty response from CAN client");

		let temp = responseBody.trim().toLowerCase();
		return {
			value: parseInt(temp),
			unit: "°C"
		};
	}

	function getCANUrl(clientName: string, operation: string = ""): string
	{
		if (operation !== "")
			operation = "/" + operation;
		return `${canBusBase}/${clientName}${operation}`;
	}

	function isSuccess(res): boolean
	{
		if (!res || !res.statusCode)
			return false;
		return res.statusCode >= 200 && res.statusCode < 300;
	}
}

export = flipdot;
