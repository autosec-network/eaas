import { component$ } from '@builder.io/qwik';
import { PropertiesTable } from '~/components/properties-table/properties-table';

interface UserPropertiesProps {
	properties: Record<string, unknown>;
}

export const UserProperties = component$<UserPropertiesProps>(({ properties }) => {
	// Email gets its own callout above the table
	return <PropertiesTable title="User Properties" properties={properties} hiddenKeys={['email']} />;
});
