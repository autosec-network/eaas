export enum TenantLogEventType {
	created = 0,
	'changed vault' = 1,
	'changed byo vault token' = 2,
}

export enum TenantLogEventStatus {
	success = 0,
	denied = 1,
	error = 2,
}
